import type { Filter } from 'nostr-tools/filter';
import { matchFilter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';

/** The two things the transport needs from relays. Small on purpose, so tests can fake it. */
export interface RelayPool {
  /** Resolves once at least one relay accepted the event, rejects if none did. */
  publish(relays: string[], event: NostrEvent): Promise<void>;
  subscribe(relays: string[], filter: Filter, onEvent: (event: NostrEvent) => void): { close(): void };
  close(): void;
}

/** Real relays over WebSocket, via nostr-tools' SimplePool (verifies event signatures). */
export class SimpleRelayPool implements RelayPool {
  private readonly pool = new SimplePool({ enablePing: true, enableReconnect: true });

  async publish(relays: string[], event: NostrEvent): Promise<void> {
    if (relays.length === 0) throw new Error('no relays to publish to');
    await Promise.any(this.pool.publish(relays, event));
  }

  subscribe(relays: string[], filter: Filter, onEvent: (event: NostrEvent) => void): { close(): void } {
    const sub = this.pool.subscribeMany(relays, filter, { onevent: onEvent });
    return { close: () => sub.close() };
  }

  close(): void {
    this.pool.destroy();
  }
}

/** A relay that lives in memory. For tests and the offline demo. */
export class MemoryRelayPool implements RelayPool {
  readonly events: { relays: string[]; event: NostrEvent }[] = [];
  private readonly subs = new Set<{ relays: string[]; filter: Filter; onEvent: (e: NostrEvent) => void }>();

  async publish(relays: string[], event: NostrEvent): Promise<void> {
    if (relays.length === 0) throw new Error('no relays to publish to');
    this.events.push({ relays, event });
    for (const s of this.subs) {
      if (s.relays.some((r) => relays.includes(r)) && matchFilter(s.filter, event)) s.onEvent(event);
    }
  }

  subscribe(relays: string[], filter: Filter, onEvent: (event: NostrEvent) => void): { close(): void } {
    const sub = { relays, filter, onEvent };
    this.subs.add(sub);
    // Like a real relay: first replay what is stored, then stream new events.
    for (const { relays: on, event } of this.events) {
      if (on.some((r) => relays.includes(r)) && matchFilter(filter, event)) onEvent(event);
    }
    return { close: () => this.subs.delete(sub) };
  }

  close(): void {
    this.subs.clear();
  }
}
