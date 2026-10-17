import type { AbstractRelay, Subscription } from 'nostr-tools/abstract-relay';
import type { Filter } from 'nostr-tools/filter';
import { matchFilter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';

/** What a subscription asks of each relay and reports back. */
export interface FeedHandlers {
  /** The filter for one relay. Asked again before every (re)subscription, so its `since` can move. */
  filter(relay: string): Filter;
  onEvent(event: NostrEvent): void;
  /**
   * `relay` has sent everything it stores for the filter, and its live stream had no gap since:
   * whatever it held up to now has arrived. Called after each full catch-up and then regularly
   * while the connection is known to be alive.
   */
  onSynced?(relay: string): void;
}

/** The two things the transport needs from relays. Small on purpose, so tests can fake it. */
export interface RelayPool {
  /** Resolves once at least one relay accepted the event, rejects if none did. */
  publish(relays: string[], event: NostrEvent): Promise<void>;
  /**
   * Stored events, then live ones, from each relay, until closed. Survives dropped connections
   * without losing events (asking again with a fresh filter) and fetches the whole backlog,
   * also past a relay's per-request cap.
   */
  subscribe(relays: string[], handlers: FeedHandlers): { close(): void };
  close(): void;
}

export interface SimpleRelayPoolOptions {
  /** Pauses before reconnecting after a failure; the last one repeats. */
  reconnectDelaysMs?: number[];
  /** How often a connection is checked (and then counts as synced up to that moment). */
  probeEveryMs?: number;
  /** A request without any answer for this long counts as failed; the connection is renewed. */
  timeoutMs?: number;
  /** Gives up opening a connection after this long. */
  connectTimeoutMs?: number;
  /** Stored events asked for per request. Relays cap this anyway (strfry: 500). */
  pageSize?: number;
  /** Most requests for one catch-up, so a flood cannot keep a device busy forever. */
  maxPages?: number;
}

const DEFAULTS: Required<SimpleRelayPoolOptions> = {
  reconnectDelaysMs: [1_000, 3_000, 10_000, 30_000, 60_000, 120_000],
  probeEveryMs: 30_000,
  timeoutMs: 25_000,
  connectTimeoutMs: 10_000,
  pageSize: 500,
  maxPages: 100,
};

/** Matches nothing: a relay answers with just EOSE, which proves the connection still works. */
const PROBE: Filter = { ids: ['0'.repeat(64)], limit: 1 };

/**
 * Real relays over WebSocket, via nostr-tools (which verifies event signatures).
 *
 * nostr-tools' own reconnect stays off: when reconnecting it asks only for events newer than the
 * newest one it saw (and changes the filter shared by all relays to that). NIP-59 wraps are
 * backdated by up to two days, so nearly everything sent during the gap was skipped, and kept
 * being filtered out afterwards. Here each relay is handled on its own: after any gap it
 * subscribes again with a fresh filter, whose `since` the transport derives from what that
 * relay last delivered in full.
 */
export class SimpleRelayPool implements RelayPool {
  private readonly pool = new SimplePool({ enablePing: false, enableReconnect: false });
  private readonly feeds = new Set<RelayFeed>();
  private readonly cfg: Required<SimpleRelayPoolOptions>;

  constructor(options: SimpleRelayPoolOptions = {}) {
    this.cfg = { ...DEFAULTS, ...options };
  }

  async publish(relays: string[], event: NostrEvent): Promise<void> {
    if (relays.length === 0) throw new Error('no relays to publish to');
    await firstFulfilled(this.pool.publish(relays, event));
  }

  subscribe(relays: string[], handlers: FeedHandlers): { close(): void } {
    const feeds = [...new Set(relays)].map((url) => new RelayFeed(this.pool, url, handlers, this.cfg));
    for (const f of feeds) {
      this.feeds.add(f);
      f.start();
    }
    return {
      close: () => {
        for (const f of feeds) {
          f.close();
          this.feeds.delete(f);
        }
      },
    };
  }

  close(): void {
    for (const f of this.feeds) f.close();
    this.feeds.clear();
    this.pool.destroy();
  }
}

/** One relay of a subscription: connects, catches up page by page, stays live, starts over after any gap. */
class RelayFeed {
  private closed = false;
  /** Bumped by every new attempt and by closing; callbacks of an older attempt do nothing. */
  private attempt = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subs = new Set<Subscription>();

  constructor(
    private readonly pool: SimplePool,
    private readonly url: string,
    private readonly handlers: FeedHandlers,
    private readonly cfg: Required<SimpleRelayPoolOptions>,
  ) {}

  start(): void {
    void this.connect();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reset();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const attempt = ++this.attempt;
    let relay: AbstractRelay;
    try {
      relay = await this.pool.ensureRelay(this.url, { connectionTimeout: this.cfg.connectTimeoutMs });
    } catch {
      this.fail(attempt, false);
      return;
    }
    if (attempt !== this.attempt) return;

    const base = this.handlers.filter(this.url);
    const limit = this.cfg.pageSize;
    // Stored events (newest first, one page), then live ones for as long as the connection holds.
    let page = await this.request(relay, attempt, { ...base, limit }, true);
    // Then older pages. A relay's cap is unknown, so a short page does not prove the end; only a
    // page with nothing older in it does.
    for (let n = 0; page?.oldest !== undefined && n < this.cfg.maxPages; n++) {
      const { oldest, atOldest } = page;
      const next = await this.request(relay, attempt, { ...base, until: oldest, limit }, false);
      if (!next) return;
      // `until` includes the boundary second, so events sharing it with the last page are not skipped.
      const fresh = next.events.filter((e) => !(e.created_at === oldest && atOldest.has(e.id)));
      if (fresh.length === 0) {
        // Only repeats: the end, unless a full page shares that one second (then step past it).
        if (next.events.length < limit || oldest - 1 < (base.since ?? 0)) break;
        page = { events: [], oldest: oldest - 1, atOldest: new Set() };
        continue;
      }
      const older = summarize(fresh);
      // A relay that ignores `until` would send the newest page again and again.
      if (older.oldest === undefined || older.oldest > oldest) break;
      page = older;
    }
    if (!page || attempt !== this.attempt) return;
    this.failures = 0;
    this.handlers.onSynced?.(this.url);
    this.scheduleProbe(relay, attempt);
  }

  /** Checks the connection now and then; an answer proves the live stream had no gap. */
  private scheduleProbe(relay: AbstractRelay, attempt: number): void {
    const due = Date.now() + this.cfg.probeEveryMs;
    this.probeTimer = setTimeout(async () => {
      if (attempt !== this.attempt) return;
      // Far too late: the device slept or the app was frozen in the background. The socket is
      // then most likely dead without having said so; renew it now rather than after a timeout.
      if (Date.now() - due > this.cfg.probeEveryMs) {
        this.fail(attempt, true);
        return;
      }
      const ok = await this.request(relay, attempt, PROBE, false);
      if (!ok || attempt !== this.attempt) return;
      this.handlers.onSynced?.(this.url);
      this.scheduleProbe(relay, attempt);
    }, this.cfg.probeEveryMs);
  }

  /**
   * Sends one REQ and resolves with the stored events once the relay sent EOSE, or with
   * `undefined` if the request failed (a new attempt is then already scheduled). A `live`
   * request stays open afterwards and keeps passing new events on.
   */
  private request(relay: AbstractRelay, attempt: number, filter: Filter, live: boolean): Promise<Page | undefined> {
    return new Promise((resolve) => {
      if (attempt !== this.attempt || !relay.connected) {
        resolve(undefined);
        this.fail(attempt, false);
        return;
      }
      const events: NostrEvent[] = [];
      let eosed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Silence counts as failure. nostr-tools reports an EOSE of its own after its timeout; that
      // one is set longer, so an EOSE arriving while this timer still runs came from the relay.
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (eosed) return;
          resolve(undefined);
          this.fail(attempt, true);
        }, this.cfg.timeoutMs);
      };
      const sub: Subscription = relay.subscribe([filter], {
        eoseTimeout: this.cfg.timeoutMs * 2 + 1000,
        onevent: (event) => {
          if (attempt !== this.attempt) return;
          if (!eosed) {
            events.push(event);
            arm();
          }
          this.handlers.onEvent(event);
        },
        oneose: () => {
          if (eosed || attempt !== this.attempt) return;
          eosed = true;
          clearTimeout(timer);
          if (!live) {
            this.subs.delete(sub);
            sub.close();
          }
          resolve(summarize(events));
        },
        onclose: () => {
          clearTimeout(timer);
          const current = this.subs.delete(sub);
          if (!eosed) resolve(undefined);
          // The connection dropped, or the relay closed the request.
          if (current) this.fail(attempt, false);
        },
      });
      this.subs.add(sub);
      arm();
    });
  }

  /** Ends this attempt and schedules the next one after a growing pause. */
  private fail(attempt: number, renewConnection: boolean): void {
    if (attempt !== this.attempt || this.closed) return;
    this.reset();
    // A relay that stopped answering: drop the socket, the next attempt opens a new one.
    if (renewConnection) this.pool.close([this.url]);
    const delays = this.cfg.reconnectDelaysMs;
    const delay = delays[Math.min(this.failures++, delays.length - 1)] ?? 1000;
    this.retryTimer = setTimeout(() => void this.connect(), delay * (0.8 + Math.random() * 0.4));
  }

  private reset(): void {
    this.attempt++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.probeTimer);
    const subs = [...this.subs];
    this.subs.clear();
    // After a dropped connection nostr-tools closes them itself.
    for (const s of subs) if (s.relay.connected) s.close();
  }
}

interface Page {
  events: NostrEvent[];
  /** created_at of the oldest event, if any. */
  oldest: number | undefined;
  /** Ids of the events with exactly that created_at. */
  atOldest: Set<string>;
}

function summarize(events: NostrEvent[]): Page {
  let oldest: number | undefined;
  for (const e of events) if (oldest === undefined || e.created_at < oldest) oldest = e.created_at;
  return { events, oldest, atOldest: new Set(events.filter((e) => e.created_at === oldest).map((e) => e.id)) };
}

/** A relay that lives in memory. For tests. */
export class MemoryRelayPool implements RelayPool {
  readonly events: { relays: string[]; event: NostrEvent }[] = [];
  private readonly subs = new Set<{ matches: (on: string[], e: NostrEvent) => boolean; onEvent: (e: NostrEvent) => void }>();

  async publish(relays: string[], event: NostrEvent): Promise<void> {
    if (relays.length === 0) throw new Error('no relays to publish to');
    this.events.push({ relays, event });
    for (const s of this.subs) if (s.matches(relays, event)) s.onEvent(event);
  }

  subscribe(relays: string[], handlers: FeedHandlers): { close(): void } {
    const filters = new Map(relays.map((r) => [r, handlers.filter(r)]));
    const matches = (on: string[], e: NostrEvent) =>
      on.some((r) => {
        const f = filters.get(r);
        return f !== undefined && matchFilter(f, e);
      });
    const sub = { matches, onEvent: (e: NostrEvent) => handlers.onEvent(e) };
    this.subs.add(sub);
    // Like a real relay: first replay what is stored, then stream new events.
    for (const { relays: on, event } of this.events) if (matches(on, event)) handlers.onEvent(event);
    for (const r of filters.keys()) handlers.onSynced?.(r);
    return { close: () => this.subs.delete(sub) };
  }

  close(): void {
    this.subs.clear();
  }
}

/** Promise.any without relying on it, since not every React Native runtime ships it. */
function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let failed = 0;
    const reasons: unknown[] = [];
    if (promises.length === 0) reject(new Error('no relays'));
    promises.forEach((p, i) =>
      p.then(resolve, (reason: unknown) => {
        reasons[i] = reason;
        if (++failed === promises.length) reject(new Error(`all relays failed: ${reasons.map(String).join('; ')}`));
      }),
    );
  });
}
