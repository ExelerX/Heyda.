import { parseAppMessage, serializeAppMessage, type AppMessage } from '../protocol/messages';
import type { ContactKey, IncomingMessage, SendOptions, Transport } from './transport';

/**
 * In-process network for tests and the app's demo mode.
 * Messages go through the real serializer and parser, so validation is exercised.
 * Several transports may share one key (one account on several devices); each gets every message.
 */
export class MemoryNetwork {
  private readonly nodes = new Map<ContactKey, Set<MemoryTransport>>();
  private readonly mailbox = new Map<ContactKey, { from: ContactKey; raw: string }[]>();
  /** Every message sent, for tests that check what left a device. */
  readonly log: { from: ContactKey; to: ContactKey; message: AppMessage; options?: SendOptions }[] = [];

  createTransport(key: ContactKey, now: () => number = Date.now): MemoryTransport {
    const t = new MemoryTransport(this, key, now);
    const set = this.nodes.get(key) ?? new Set();
    set.add(t);
    this.nodes.set(key, set);
    // Messages sent before any device with this key existed wait for the first one.
    for (const m of this.mailbox.get(key) ?? []) t.pending.push(m);
    this.mailbox.delete(key);
    return t;
  }

  /** @internal */
  deliver(from: ContactKey, to: ContactKey, raw: string): void {
    const targets = this.nodes.get(to);
    if (!targets?.size) {
      const box = this.mailbox.get(to) ?? [];
      box.push({ from, raw });
      this.mailbox.set(to, box);
      return;
    }
    for (const target of targets) {
      if (target.running) queueMicrotask(() => target.receive(from, raw));
      else target.pending.push({ from, raw });
    }
  }
}

export class MemoryTransport implements Transport {
  running = false;
  /** Messages that arrived while stopped, like a relay keeping them. */
  readonly pending: { from: ContactKey; raw: string }[] = [];
  private readonly handlers = new Set<(m: IncomingMessage) => void>();

  constructor(
    private readonly network: MemoryNetwork,
    readonly selfKey: ContactKey,
    private readonly now: () => number,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    for (const { from, raw } of this.pending.splice(0)) this.receive(from, raw);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(to: ContactKey, message: AppMessage, options?: SendOptions): Promise<void> {
    const raw = serializeAppMessage(message);
    this.network.log.push({ from: this.selfKey, to, message, options });
    this.network.deliver(this.selfKey, to, raw);
  }

  onMessage(handler: (m: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** @internal */
  receive(from: ContactKey, raw: string): void {
    const parsed = parseAppMessage(raw);
    if (!parsed.ok) return;
    const incoming = { from, message: parsed.message, receivedAt: this.now() };
    for (const h of this.handlers) h(incoming);
  }
}
