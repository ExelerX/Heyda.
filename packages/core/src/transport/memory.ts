import { parseAppMessage, serializeAppMessage, type AppMessage } from '../protocol/messages';
import type { ContactKey, IncomingMessage, Transport } from './transport';

/**
 * In-process network for tests and the app's demo mode.
 * Messages go through the real serializer and parser, so validation is exercised.
 */
export class MemoryNetwork {
  private readonly nodes = new Map<ContactKey, MemoryTransport>();
  private readonly mailbox = new Map<ContactKey, { from: ContactKey; raw: string }[]>();

  createTransport(key: ContactKey, now: () => number = Date.now): MemoryTransport {
    const t = new MemoryTransport(this, key, now);
    this.nodes.set(key, t);
    return t;
  }

  /** @internal */
  deliver(from: ContactKey, to: ContactKey, raw: string): void {
    const target = this.nodes.get(to);
    if (target?.running) {
      queueMicrotask(() => target.receive(from, raw));
    } else {
      const box = this.mailbox.get(to) ?? [];
      box.push({ from, raw });
      this.mailbox.set(to, box);
    }
  }

  /** @internal */
  drain(key: ContactKey): { from: ContactKey; raw: string }[] {
    const box = this.mailbox.get(key) ?? [];
    this.mailbox.delete(key);
    return box;
  }
}

export class MemoryTransport implements Transport {
  running = false;
  private readonly handlers = new Set<(m: IncomingMessage) => void>();

  constructor(
    private readonly network: MemoryNetwork,
    readonly selfKey: ContactKey,
    private readonly now: () => number,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    for (const { from, raw } of this.network.drain(this.selfKey)) this.receive(from, raw);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(to: ContactKey, message: AppMessage): Promise<void> {
    this.network.deliver(this.selfKey, to, serializeAppMessage(message));
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
