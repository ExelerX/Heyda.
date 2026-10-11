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
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure';
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

/** NIP-59 backdates wraps by up to two days to hide timing, so look back that far. */
const WRAP_BACKDATE_S = 2 * 24 * 3600;
const MAX_WRAP_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_S = 10 * 60;

/** Remembers what was already processed, across app restarts. */
export interface SeenStore {
  lastSyncSeconds(): number;
  setLastSyncSeconds(seconds: number): void;
  has(rumorId: string): boolean;
  add(rumorId: string): void;
}

/** Bounded in-memory store; the app persists it via its own storage. */
export class MemorySeenStore implements SeenStore {
  private sync = 0;
  private readonly ids = new Set<string>();
  constructor(private readonly max = 5000) {}
  lastSyncSeconds(): number {
    return this.sync;
  }
  setLastSyncSeconds(seconds: number): void {
    this.sync = Math.max(this.sync, seconds);
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!);
  }
  snapshot(): { sync: number; ids: string[] } {
    return { sync: this.sync, ids: [...this.ids] };
  }
  static restore(data: { sync: number; ids: string[] }, max?: number): MemorySeenStore {
    const s = new MemorySeenStore(max);
    s.sync = data.sync;
    data.ids.forEach((id) => s.ids.add(id));
    return s;
  }
}

export interface NostrTransportOptions {
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
  private readonly pool: RelayPool;
  private readonly seen: SeenStore;
  private readonly now: () => number;
  private readonly maxAge: number;
  private readonly handlers = new Set<(m: IncomingMessage) => void>();
  private sub: { close(): void } | undefined;

  constructor(private readonly opts: NostrTransportOptions) {
    this.selfKey = getPublicKey(opts.secretKey);
    this.pool = opts.pool ?? new SimpleRelayPool();
    this.seen = opts.seen ?? new MemorySeenStore();
    this.now = opts.now ?? Date.now;
    this.maxAge = opts.maxAgeSeconds ?? 8 * 24 * 3600;
  }

  async start(): Promise<void> {
    if (this.sub) return;
    const since = Math.max(0, this.seen.lastSyncSeconds() - WRAP_BACKDATE_S - 3600);
    this.sub = this.pool.subscribe(
      this.opts.ownRelays,
      { kinds: [GIFT_WRAP_KIND], '#p': [this.selfKey], since },
      (event) => this.handleWrap(event),
    );
  }

  async stop(): Promise<void> {
    if (!this.sub) return;
    this.sub.close();
    this.sub = undefined;
    // Next start only asks relays for what arrived since (minus the backdating window).
    this.seen.setLastSyncSeconds(Math.floor(this.now() / 1000) - 60);
  }

  async send(to: ContactKey, message: AppMessage, options: SendOptions = {}): Promise<void> {
    const content = serializeAppMessage(message);
    const nowS = Math.floor(this.now() / 1000);
    const rumor = createRumor({ kind: APP_RUMOR_KIND, content, tags: [], created_at: nowS }, this.opts.secretKey);
    const seal = createSeal(rumor, this.opts.secretKey, to);
    const wrap = this.createWrap(seal, to, options.ttlSeconds ? nowS + options.ttlSeconds : undefined);
    const relays = this.opts.relaysFor(to);
    await this.pool.publish(relays.length ? relays : this.opts.ownRelays, wrap);
  }

  onMessage(handler: (m: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Like nostr-tools' createWrap, plus a NIP-40 expiration so relays can delete it. */
  private createWrap(seal: NostrEvent, recipient: string, expiresAt: number | undefined): NostrEvent {
    const oneTimeKey = generateSecretKey();
    const nowS = Math.floor(this.now() / 1000);
    const tags = [['p', recipient]];
    if (expiresAt) tags.push(['expiration', String(expiresAt + WRAP_BACKDATE_S)]);
    return finalizeEvent(
      {
        kind: GIFT_WRAP_KIND,
        content: nip44Encrypt(JSON.stringify(seal), getConversationKey(oneTimeKey, recipient)),
        created_at: nowS - Math.floor(secureRandom() * WRAP_BACKDATE_S),
        tags,
      },
      oneTimeKey,
    );
  }

  private handleWrap(event: NostrEvent): void {
    try {
      if (event.kind !== GIFT_WRAP_KIND || event.content.length > MAX_WRAP_BYTES) return;
      if (!event.tags.some((t) => t[0] === 'p' && t[1] === this.selfKey)) return;
      if (!verifyEvent(event)) return;

      // Checks the seal signature and that the inner author matches the seal signer.
      const rumor = unwrapEvent(event, this.opts.secretKey);
      if (rumor.kind !== APP_RUMOR_KIND) return;

      const nowS = Math.floor(this.now() / 1000);
      if (rumor.created_at < nowS - this.maxAge || rumor.created_at > nowS + MAX_CLOCK_SKEW_S) return;
      if (this.seen.has(rumor.id)) return;
      this.seen.add(rumor.id);

      const parsed = parseAppMessage(rumor.content);
      if (!parsed.ok) return;
      const incoming: IncomingMessage = { from: rumor.pubkey, message: parsed.message, receivedAt: this.now() };
      for (const h of this.handlers) h(incoming);
    } catch (error) {
      // Undecryptable or malformed wraps are expected noise on public relays.
      this.opts.onError?.(error);
    }
  }
}

function secureRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}
