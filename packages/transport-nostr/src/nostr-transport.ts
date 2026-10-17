import {
  parseAppMessage,
  serializeAppMessage,
  type AppMessage,
  type ContactKey,
  type IncomingMessage,
  type SendOptions,
  type Transport,
} from '@heyda/core';
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import { createRumor, createSeal, unwrapEvent } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import { SimpleRelayPool, type RelayPool } from './pool';

export const GIFT_WRAP_KIND = 1059;
/**
 * Kind of the inner event carrying our JSON. It only ever exists inside the
 * encrypted gift wrap, so relays never see it.
 */
export const APP_RUMOR_KIND = 21_420;

/**
 * Public relays run by volunteers. Anyone can add their own or self-host one;
 * contacts exchange their relay lists when pairing.
 */
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

/**
 * NIP-59 backdates wraps at random, so someone reading a relay's database later cannot tell when
 * they were sent. Relays and anyone subscribed see the arrival time anyway, so an hour is enough;
 * a catch-up then has to look back only that far, not days.
 */
const WRAP_BACKDATE_S = 3600;
/**
 * Extra look-back before the last full sync of a relay, for senders whose clock runs behind. A
 * clock more than about this far behind loses its messages in catch-ups: accepted, so that every
 * reconnect fetches the last few hours instead of days.
 */
const SYNC_MARGIN_S = 3600;
const MAX_WRAP_BYTES = 64 * 1024;
/**
 * How far a sender's clock may run ahead of mine. Generous on purpose: ten minutes silently
 * dropped everything, an SOS included, from phones whose clock was set by hand or to the wrong
 * time zone. Replays are bounded by `maxAgeSeconds` and the seen store, not by this.
 */
const MAX_CLOCK_SKEW_S = 2 * 24 * 3600;
/**
 * Messages from senders not known yet are kept this long in memory, in case they become known
 * (my other device's sync can be late when it was offline). Bounded, so strangers cannot fill memory.
 */
const REFUSED_TTL_MS = 24 * 3600_000;
const MAX_REFUSED = 200;
const MAX_REFUSED_PER_SENDER = 50;
const MAX_REFUSED_CHARS = 2_000_000;

/**
 * Wraps turned away for now (a sender not known yet, a message this version cannot read, one from
 * the future) are not opened again until contacts or groups change, or the app restarts.
 */
const MAX_LATER = 5000;
/** How often the seen store forgets what no longer matters. */
const PRUNE_EVERY_S = 3600;

/** Remembers what was already processed, across app restarts. */
export interface SeenStore {
  /** Per relay: everything it held up to this time (epoch seconds) has arrived. 0 if unknown. */
  syncedUntil(relay: string): number;
  setSyncedUntil(relay: string, seconds: number): void;
  /** Inner messages (rumor ids) already handed to the app. */
  has(rumorId: string): boolean;
  /** `keepUntil` (epoch seconds): from then on the transport drops the message for its age anyway. */
  add(rumorId: string, keepUntil: number): void;
  /** Gift wraps already dealt with (junk included), so copies from other relays or a later catch-up cost nothing. */
  hasWrap(wrapId: string): boolean;
  addWrap(wrapId: string, keepUntil: number): void;
  /** A wrap that can never be read. Kept apart, so junk cannot push out the wraps that matter. */
  addJunk(wrapId: string, keepUntil: number): void;
  /** Forgets what no longer matters at `nowS`. */
  prune(nowS: number): void;
}

export interface SeenSnapshot {
  /** Written by older versions: one time for all relays. Only a fallback now. */
  sync: number;
  /** Written by older versions: rumor ids, without times. */
  ids: string[];
  relays?: Record<string, number>;
  /** Written by older versions: wrap ids, without times. */
  wraps?: string[];
  /** Short ids, each with the time (epoch seconds) until which it matters. */
  messageIds?: [string, number][];
  wrapIds?: [string, number][];
  junkIds?: [string, number][];
}

const MAX_RELAY_ENTRIES = 32;
const MAX_JUNK = 5000;
/**
 * Ids are hashes nobody can aim at a message not yet received: 64 bits are plenty to recognize
 * them and keep the saved file small.
 */
const shortId = (id: string) => id.slice(0, 16);

/** Ids with the time (epoch seconds) until which each matters. */
class TimedIds {
  private readonly ids = new Map<string, number>();
  constructor(
    /** The newest this many stay whatever their time: a clock that ran days ahead for a while must not wipe them. */
    private readonly keep: number,
    /** Only against running out of memory: past it, the oldest go. */
    private readonly cap: number,
  ) {}
  has(id: string): boolean {
    return this.ids.has(shortId(id));
  }
  add(id: string, keepUntil: number): void {
    const key = shortId(id);
    const until = Number.isFinite(keepUntil) ? Math.floor(keepUntil) : 0;
    if ((this.ids.get(key) ?? -Infinity) >= until) return;
    this.ids.set(key, until);
    if (this.ids.size > this.cap) this.drop(this.ids.size - Math.floor(this.cap * 0.9), Infinity);
  }
  prune(nowS: number): void {
    if (this.ids.size > this.keep) this.drop(this.ids.size - this.keep, nowS);
  }
  entries(): [string, number][] {
    return [...this.ids];
  }
  /** Drops up to `count` ids whose time is before `before`, oldest first. */
  private drop(count: number, before: number): void {
    for (const [id, until] of [...this.ids].sort((a, b) => a[1] - b[1])) {
      if (count-- <= 0 || until >= before) return;
      this.ids.delete(id);
    }
  }
}

/** In memory; the app persists it via its own storage. */
export class MemorySeenStore implements SeenStore {
  private sync = 0;
  private readonly relays = new Map<string, number>();
  private readonly ids: TimedIds;
  private readonly wraps: TimedIds;
  private readonly junk = new TimedIds(0, MAX_JUNK);
  /**
   * Keeps every id until a catch-up would drop its message for age anyway: one handed over again
   * would ring, notify or trigger automations a second time. `keep` and `keepWraps` of the newest
   * stay even then; `cap` per list only protects memory.
   */
  constructor(keep = 5000, keepWraps = 8000, cap = 50_000) {
    this.ids = new TimedIds(keep, Math.max(cap, keep));
    this.wraps = new TimedIds(keepWraps, Math.max(cap, keepWraps));
  }
  syncedUntil(relay: string): number {
    return this.relays.get(relay) ?? this.sync;
  }
  setSyncedUntil(relay: string, seconds: number): void {
    if (!Number.isSafeInteger(seconds)) return;
    // The latest observation wins, also a smaller one after the clock was set back.
    this.relays.delete(relay);
    this.relays.set(relay, seconds);
    if (this.relays.size > MAX_RELAY_ENTRIES) this.relays.delete(this.relays.keys().next().value!);
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string, keepUntil: number): void {
    this.ids.add(id, keepUntil);
  }
  hasWrap(id: string): boolean {
    return this.wraps.has(id) || this.junk.has(id);
  }
  addWrap(id: string, keepUntil: number): void {
    this.wraps.add(id, keepUntil);
  }
  addJunk(id: string, keepUntil: number): void {
    this.junk.add(id, keepUntil);
  }
  prune(nowS: number): void {
    this.ids.prune(nowS);
    this.wraps.prune(nowS);
    this.junk.prune(nowS);
  }
  snapshot(): SeenSnapshot {
    return {
      sync: this.sync,
      ids: [],
      relays: Object.fromEntries(this.relays),
      messageIds: this.ids.entries(),
      wrapIds: this.wraps.entries(),
      junkIds: this.junk.entries(),
    };
  }
  /** Tolerates data from older versions and anything malformed. */
  static restore(data: Partial<SeenSnapshot> | undefined, keep?: number, keepWraps?: number): MemorySeenStore {
    const s = new MemorySeenStore(keep, keepWraps);
    if (!data || typeof data !== 'object') return s;
    if (Number.isSafeInteger(data.sync)) s.sync = data.sync!;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const timed = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number') : [];
    // Saved without a time: they count as expired, the first to go once more than `keep` are stored.
    for (const id of strings(data.ids)) s.ids.add(id, 0);
    for (const id of strings(data.wraps)) s.wraps.add(id, 0);
    for (const [id, until] of timed(data.messageIds)) s.ids.add(id, until);
    for (const [id, until] of timed(data.wrapIds)) s.wraps.add(id, until);
    for (const [id, until] of timed(data.junkIds)) s.junk.add(id, until);
    if (data.relays && typeof data.relays === 'object') {
      for (const [relay, seconds] of Object.entries(data.relays)) s.setSyncedUntil(relay, seconds);
    }
    return s;
  }
}

export interface NostrTransportOptions {
  /** Copied: the caller may wipe its array right away. `dispose()` wipes the copy. */
  secretKey: Uint8Array;
  /** Relays this phone listens on. Shared with contacts in the QR invite. */
  ownRelays: string[];
  /** Where a contact listens, from their invite or hello. */
  relaysFor: (contact: ContactKey) => string[];
  pool?: RelayPool;
  seen?: SeenStore;
  /** Epoch ms. */
  now?: () => number;
  /** Older messages are dropped, so a relay replaying old wraps cannot confuse the app. */
  maxAgeSeconds?: number;
  onError?: (error: unknown) => void;
  /**
   * Whether the app acts on a message from this sender at all (`SocialNode.acceptsMessage`).
   * Rejected messages are dropped before they are recorded as processed. Without it a
   * stranger who knows my key can flood the bounded seen store until real ids fall out, then
   * re-publish old wraps (anyone can fetch them from public relays) to have them handled again.
   * They are kept for a while in memory, though, and offered again by `redeliverRefused()`.
   */
  accept?: (from: ContactKey, message: AppMessage) => boolean;
}

interface Refused {
  wrapId: string;
  /** For the seen store, once handed over. */
  wrapUntil: number;
  keepUntil: number;
  from: ContactKey;
  message: AppMessage;
  until: number;
  chars: number;
}

export function generateIdentity(): { secretKey: Uint8Array; publicKey: string } {
  const secretKey = generateSecretKey();
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

/**
 * Serverless transport: messages are NIP-44 encrypted and NIP-59 gift-wrapped,
 * then left on public relays until the recipient picks them up.
 *
 * Relays see only that some one-time key sent an encrypted blob to the recipient's
 * public key at a randomized time. They never see the sender, the content or locations.
 * Known limit: NIP-44 has no forward secrecy, so a stolen key exposes stored messages.
 */
export class NostrTransport implements Transport {
  readonly selfKey: ContactKey;
  private readonly secretKey: Uint8Array;
  private readonly pool: RelayPool;
  private readonly ownsPool: boolean;
  private readonly seen: SeenStore;
  private readonly now: () => number;
  private readonly maxAge: number;
  private readonly handlers = new Set<(m: IncomingMessage) => void>();
  /** Messages `accept` turned down, by rumor id, oldest first. */
  private readonly refused = new Map<string, Refused>();
  /** Short ids of wraps turned away for now (see `MAX_LATER`), oldest first. */
  private readonly later = new Set<string>();
  private prunedAt: number | undefined;
  private sub: { close(): void } | undefined;
  /** Resolves once every own relay caught up after the last `start()`. */
  private backlog: Promise<void> | undefined;
  /** Waits from `caughtUpAgain()`: the own relays each still has to report caught up. */
  private readonly resyncs = new Set<{ pending: Set<string>; done: () => void }>();
  private disposed = false;

  constructor(private readonly opts: NostrTransportOptions) {
    // A copy, kept for every later send and decryption: the app wipes the array it passed in.
    this.secretKey = Uint8Array.from(opts.secretKey);
    this.selfKey = getPublicKey(this.secretKey);
    this.ownsPool = !opts.pool;
    this.pool = opts.pool ?? new SimpleRelayPool();
    this.seen = opts.seen ?? new MemorySeenStore();
    this.now = opts.now ?? Date.now;
    this.maxAge = opts.maxAgeSeconds ?? 8 * 24 * 3600;
  }

  async start(): Promise<void> {
    if (this.sub) return;
    if (this.disposed) throw new Error('transport disposed');
    // Every own relay caught up once: then what waited while this device was off is in.
    const pending = new Set(this.opts.ownRelays);
    let backlogIn!: () => void;
    this.backlog = new Promise<void>((resolve) => (backlogIn = resolve));
    if (pending.size === 0) backlogIn();
    this.pruneSeen();
    this.sub = this.pool.subscribe(this.opts.ownRelays, {
      filter: (relay) => ({ kinds: [GIFT_WRAP_KIND], '#p': [this.selfKey], since: this.sinceFor(relay) }),
      onEvent: (event) => this.handleWrap(event),
      handled: (id) => this.handled(id),
      onSynced: (relay) => {
        this.seen.setSyncedUntil(relay, this.nowS() - 60);
        this.pruneSeen();
        if (pending.delete(relay) && pending.size === 0) backlogIn();
        for (const r of [...this.resyncs]) {
          if (r.pending.delete(relay) && r.pending.size === 0) r.done();
        }
      },
    });
  }

  caughtUp(): Promise<void> {
    return this.backlog ?? Promise.resolve();
  }

  /**
   * Resolves once every own relay has reported again, after this call, that it handed over what it
   * kept: after the device slept, a relay reconnects and catches up first (a live connection that
   * survived proves itself with its next check). Callers wait only a while: a relay may be down.
   */
  caughtUpAgain(): Promise<void> {
    if (!this.sub) return Promise.resolve();
    const pending = new Set(this.opts.ownRelays);
    if (pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wait = {
        pending,
        done: () => {
          this.resyncs.delete(wait);
          resolve();
        },
      };
      this.resyncs.add(wait);
    });
  }

  async stop(): Promise<void> {
    if (!this.sub) return;
    this.sub.close();
    this.sub = undefined;
    // Nothing more arrives: nobody needs to wait for it.
    for (const r of [...this.resyncs]) r.done();
  }

  /** Stops for good: wipes the key copy and closes the relay connections it opened itself. */
  async dispose(): Promise<void> {
    await this.stop();
    if (this.disposed) return;
    this.disposed = true;
    this.secretKey.fill(0);
    this.refused.clear();
    this.later.clear();
    if (this.ownsPool) this.pool.close();
  }

  async send(to: ContactKey, message: AppMessage, options: SendOptions = {}): Promise<void> {
    if (this.disposed) throw new Error('transport disposed');
    const content = serializeAppMessage(message);
    const nowS = this.nowS();
    const rumor = createRumor({ kind: APP_RUMOR_KIND, content, tags: [], created_at: nowS }, this.secretKey);
    const seal = createSeal(rumor, this.secretKey, to);
    const wrap = this.createWrap(seal, to);
    const relays = options.relays?.length ? options.relays : this.opts.relaysFor(to);
    await this.pool.publish(relays.length ? relays : this.opts.ownRelays, wrap);
  }

  onMessage(handler: (m: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Offers messages again that `accept` turned down because their sender was not known yet: a
   * new contact's first chat can reach my desktop before my phone's sync about them does, and
   * a catch-up delivers in random order (a new member's message before the group update). The
   * node calls this after it learned contacts or group members.
   */
  redeliverRefused(): void {
    if (this.disposed) return;
    // The next catch-up opens again what was turned away, also what no longer fitted in memory.
    this.later.clear();
    const now = this.now();
    for (const [rumorId, r] of [...this.refused]) {
      if (!this.refused.has(rumorId)) continue;
      if (r.until < now || this.seen.has(rumorId)) {
        this.refused.delete(rumorId);
        continue;
      }
      if (this.opts.accept && !this.opts.accept(r.from, r.message)) {
        this.markLater(r.wrapId);
        continue;
      }
      this.refused.delete(rumorId);
      this.seen.addWrap(r.wrapId, r.wrapUntil);
      this.deliver(rumorId, r.keepUntil, r.from, r.message);
    }
  }

  private nowS(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Dealt with, or turned away for now: a copy needs neither its signature checked nor opening. */
  private handled(wrapId: string): boolean {
    return this.seen.hasWrap(wrapId) || this.later.has(shortId(wrapId));
  }

  private markLater(wrapId: string): void {
    this.later.add(shortId(wrapId));
    if (this.later.size > MAX_LATER) this.later.delete(this.later.values().next().value!);
  }

  private pruneSeen(): void {
    const nowS = this.nowS();
    if (this.prunedAt !== undefined && Math.abs(nowS - this.prunedAt) < PRUNE_EVERY_S) return;
    this.prunedAt = nowS;
    this.seen.prune(nowS);
  }

  /** Until then a wrap may hold a message young enough to take: its contents are at most WRAP_BACKDATE_S newer. */
  private wrapUntil(wrap: NostrEvent): number {
    return wrap.created_at + WRAP_BACKDATE_S + this.maxAge;
  }

  /** Where a catch-up from this relay starts. */
  private sinceFor(relay: string): number {
    const nowS = this.nowS();
    let synced = this.seen.syncedUntil(relay);
    // Ahead of my clock: the clock was set back since, so it tells nothing.
    if (synced > nowS) synced = 0;
    // Older wraps can only hold messages past maxAge, which are dropped anyway.
    const oldestUseful = nowS - this.maxAge - WRAP_BACKDATE_S;
    return Math.max(0, oldestUseful, synced - WRAP_BACKDATE_S - SYNC_MARGIN_S);
  }

  /**
   * Like nostr-tools' createWrap, plus a NIP-40 expiration so relays can delete it once no
   * recipient takes its message any more. The same for every message, counted from the randomized
   * created_at: one derived from the message's TTL told relays which kind of message it was (an
   * SOS, a live location, a device link) and when it was really sent. Relays may ignore it.
   */
  private createWrap(seal: NostrEvent, recipient: string): NostrEvent {
    const oneTimeKey = generateSecretKey();
    const createdAt = this.nowS() - Math.floor(secureRandom() * WRAP_BACKDATE_S);
    const wrap = finalizeEvent(
      {
        kind: GIFT_WRAP_KIND,
        content: nip44Encrypt(JSON.stringify(seal), getConversationKey(oneTimeKey, recipient)),
        created_at: createdAt,
        tags: [
          ['p', recipient],
          ['expiration', String(createdAt + WRAP_BACKDATE_S + this.maxAge)],
        ],
      },
      oneTimeKey,
    );
    oneTimeKey.fill(0);
    return wrap;
  }

  private handleWrap(event: NostrEvent): void {
    let verified = false;
    try {
      if (event.kind !== GIFT_WRAP_KIND || event.content.length > MAX_WRAP_BYTES) return;
      // Seen before: on another relay, in the overlap after a reconnect, or before a restart.
      if (this.handled(event.id)) return;
      const nowS = this.nowS();
      const wrapUntil = this.wrapUntil(event);
      if (wrapUntil < nowS) return;
      if (!event.tags.some((t) => t[0] === 'p' && t[1] === this.selfKey)) return;
      if (!verifyEvent(event)) return;
      // From here the id is the wrap's own hash, so recording it cannot hide a different wrap.
      verified = true;
      const outcome = this.open(event, nowS);
      if (outcome === 'done') this.seen.addWrap(event.id, wrapUntil);
      else if (outcome === 'junk') this.seen.addJunk(event.id, wrapUntil);
      else this.markLater(event.id);
    } catch (error) {
      // Undecryptable or malformed wraps are expected noise on public relays, and stay so.
      if (verified) this.seen.addJunk(event.id, this.wrapUntil(event));
      this.opts.onError?.(error);
    }
  }

  /**
   * Unwraps and hands the message on: `done`. `junk` if it can never be taken, `later` if it may be
   * worth another look (a sender who may become known, a newer version's message after an update).
   */
  private open(event: NostrEvent, nowS: number): 'done' | 'junk' | 'later' {
    // Checks the seal signature and that the inner author matches the seal signer.
    const rumor = unwrapEvent(event, this.secretKey);
    if (rumor.kind !== APP_RUMOR_KIND || typeof rumor.content !== 'string' || !Number.isSafeInteger(rumor.created_at)) return 'junk';
    // The rumor is unsigned: its id is a fair key for "already processed" only if it is its hash.
    if (getEventHash(rumor) !== rumor.id) return 'junk';
    if (rumor.created_at < nowS - this.maxAge) return 'junk';
    if (rumor.created_at > nowS + MAX_CLOCK_SKEW_S) return 'later';
    if (this.seen.has(rumor.id)) return 'done';

    // Only messages the app would act on take room in the seen store.
    const parsed = parseAppMessage(rumor.content);
    // Perhaps a kind of message from a newer version: worth another look after an update.
    if (!parsed.ok) return 'later';
    const keepUntil = rumor.created_at + this.maxAge;
    if (this.opts.accept && !this.opts.accept(rumor.pubkey, parsed.message)) {
      this.holdRefused(rumor.id, {
        wrapId: event.id,
        wrapUntil: this.wrapUntil(event),
        keepUntil,
        from: rumor.pubkey,
        message: parsed.message,
        until: this.now() + REFUSED_TTL_MS,
        chars: rumor.content.length,
      });
      return 'later';
    }
    this.deliver(rumor.id, keepUntil, rumor.pubkey, parsed.message);
    return 'done';
  }

  private deliver(rumorId: string, keepUntil: number, from: ContactKey, message: AppMessage): void {
    this.seen.add(rumorId, keepUntil);
    const incoming: IncomingMessage = { from, message, receivedAt: this.now() };
    for (const h of [...this.handlers]) {
      try {
        h(incoming);
      } catch (error) {
        this.opts.onError?.(error);
      }
    }
  }

  /** Keeps a turned-down message for a while; the oldest go first when a limit is reached. */
  private holdRefused(rumorId: string, entry: Refused): void {
    if (this.refused.has(rumorId)) return;
    const fromSender = [...this.refused].filter(([, r]) => r.from === entry.from);
    if (fromSender.length >= MAX_REFUSED_PER_SENDER) this.refused.delete(fromSender[0]![0]);
    this.refused.set(rumorId, entry);
    let chars = 0;
    for (const r of this.refused.values()) chars += r.chars;
    while (this.refused.size > MAX_REFUSED || chars > MAX_REFUSED_CHARS) {
      const [oldest, r] = this.refused.entries().next().value!;
      this.refused.delete(oldest);
      chars -= r.chars;
    }
  }
}

function secureRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}
