import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';

/**
 * Test double: NIP-01 relays living in memory, reached through a fake WebSocket that nostr-tools
 * can use. Stored events come back newest first and capped per request like strfry (damus, nos.lol).
 */
export class FakeRelay {
  readonly events: NostrEvent[] = [];
  /** Every REQ this relay got: its filters. */
  readonly reqs: Filter[][] = [];
  readonly connections = new Set<FakeWebSocket>();
  /** While down, new connections fail. */
  down = false;

  constructor(
    readonly url: string,
    readonly cap = 500,
  ) {}

  /** The network between one client and the relay goes away (Wi-Fi to mobile data, doze, relay restart). */
  dropWhere(which: (c: FakeWebSocket) => boolean): void {
    for (const c of [...this.connections]) if (which(c)) c.serverClose();
  }

  store(event: NostrEvent): void {
    if (this.events.some((e) => e.id === event.id)) return;
    this.events.push(event);
    for (const c of this.connections) c.broadcast(event);
  }
}

export class FakeRelayNetwork {
  readonly relays = new Map<string, FakeRelay>();

  add(url: string, cap?: number): FakeRelay {
    const relay = new FakeRelay(url, cap);
    this.relays.set(url, relay);
    return relay;
  }

  /** A WebSocket class bound to this network, for `useWebSocketImplementation`. */
  get WebSocket(): typeof WebSocket {
    const network = this;
    class Bound extends FakeWebSocket {
      constructor(url: string) {
        super(network, url);
      }
    }
    return Bound as unknown as typeof WebSocket;
  }
}

type Handler = ((ev: { data?: string; message?: string }) => void) | null;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  stalled = false;
  onopen: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  onmessage: Handler = null;
  private readonly subs = new Map<string, Filter[]>();
  private readonly relay: FakeRelay | undefined;

  constructor(network: FakeRelayNetwork, url: string) {
    this.relay = network.relays.get(url.replace(/\/$/, ''));
    setTimeout(() => {
      if (!this.relay || this.relay.down) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({ message: 'connection refused' });
        return;
      }
      this.relay.connections.add(this);
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }

  /** Whether this connection has a subscription for events addressed to `pubkey`. */
  listensFor(pubkey: string): boolean {
    return [...this.subs.values()].some((filters) => filters.some((f) => f['#p']?.includes(pubkey)));
  }

  send(raw: string): void {
    const relay = this.relay;
    if (this.readyState !== 1 || !relay || this.stalled) return;
    const msg = JSON.parse(raw) as unknown[];
    if (msg[0] === 'REQ') {
      const id = msg[1] as string;
      const filters = msg.slice(2) as Filter[];
      relay.reqs.push(filters);
      this.subs.set(id, filters);
      const hits = new Map<string, NostrEvent>();
      for (const f of filters) {
        const matching = relay.events.filter((e) => matchFilter(f, e)).sort((a, b) => b.created_at - a.created_at);
        for (const e of matching.slice(0, Math.min(f.limit ?? relay.cap, relay.cap))) hits.set(e.id, e);
      }
      for (const e of [...hits.values()].sort((a, b) => b.created_at - a.created_at)) this.out(['EVENT', id, e]);
      this.out(['EOSE', id]);
    } else if (msg[0] === 'EVENT') {
      const event = msg[1] as NostrEvent;
      this.out(['OK', event.id, true, '']);
      relay.store(event);
    } else if (msg[0] === 'CLOSE') {
      this.subs.delete(msg[1] as string);
    }
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.relay?.connections.delete(this);
    setTimeout(() => this.onclose?.({ message: 'closed by client' }), 1);
  }

  /** @internal */
  serverClose(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.relay?.connections.delete(this);
    setTimeout(() => this.onclose?.({ message: 'gone' }), 1);
  }

  /** @internal */
  broadcast(event: NostrEvent): void {
    for (const [id, filters] of this.subs) {
      if (filters.some((f) => matchFilter(f, event))) this.out(['EVENT', id, event]);
    }
  }

  private out(msg: unknown[]): void {
    if (this.readyState !== 1 || this.stalled) return;
    const data = JSON.stringify(msg);
    setTimeout(() => {
      if (this.readyState === 1 && !this.stalled) this.onmessage?.({ data });
    }, 1);
  }
}

/** Waits until `check` holds, or fails after `ms`. */
export async function until(check: () => boolean, ms = 5000, label = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
