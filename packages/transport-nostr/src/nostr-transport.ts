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

/** NIP-59 backdates wraps by up to two days to hide timing, so look back that far. */
const WRAP_BACKDATE_S = 2 * 24 * 3600;
/**
 * How long relays keep a wrap (NIP-40), counted from its randomized created_at on top of the
 * backdating. The same for every message: an expiration derived from the message's TTL told
 * relays and anyone fetching wraps which kind of message it was (an SOS, a live location, a
 * device link), when it was really sent, and the deadline of a "Pass auf mich auf". Covers the
 * longest TTL in use (chats and sync, 7 days).
 */
const RELAY_RETENTION_S = 7 * 24 * 3600;
/**
 * Extra look-back before the last full sync of a relay. The backdating counts from the sender's
 * clock, which can run hours behind (set by hand, wrong time zone); their wraps must still match.
 */
const SYNC_MARGIN_S = 24 * 3600;
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

/** Remembers what was already processed, across app restarts. */
export interface SeenStore {
  /** Per relay: everything it held up to this time (epoch seconds) has arrived. 0 if unknown. */
  syncedUntil(relay: string): number;
  setSyncedUntil(relay: string, seconds: number): void;
  /** Inner messages (rumor ids) already handed to the app. */
  has(rumorId: string): boolean;
  add(rumorId: string): void;
  /** Gift wraps already dealt with, so copies from other relays or a later catch-up cost no decryption. */
  hasWrap(wrapId: string): boolean;
  addWrap(wrapId: string): void;
}

export interface SeenSnapshot {
  /** Written by older versions: one time for all relays. Only a fallback now. */
  sync: number;
  ids: string[];
  relays?: Record<string, number>;
  wraps?: string[];
}

const MAX_RELAY_ENTRIES = 32;
/** Wrap ids are hashes chosen by nobody: 64 bits are plenty to recognize them and keep the saved file small. */
const wrapKey = (id: string) => id.slice(0, 16);

/** Bounded in-memory store; the app persists it via its own storage. */
export class MemorySeenStore implements SeenStore {
  private sync = 0;
  private readonly relays = new Map<string, number>();
  private readonly ids = new Set<string>();
  private readonly wraps = new Set<string>();
  constructor(
    private readonly max = 5000,
    private readonly maxWraps = 8000,
  ) {}
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
  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!);
  }
  hasWrap(id: string): boolean {
    return this.wraps.has(wrapKey(id));
  }
  addWrap(id: string): void {
    this.wraps.add(wrapKey(id));
    if (this.wraps.size > this.maxWraps) this.wraps.delete(this.wraps.values().next().value!);
  }
  snapshot(): SeenSnapshot {
    return { sync: this.sync, ids: [...this.ids], relays: Object.fromEntries(this.relays), wraps: [...this.wraps] };
  }
  /** Tolerates data from older versions and anything malformed. */
  static restore(data: Partial<SeenSnapshot> | undefined, max?: number): MemorySeenStore {
    const s = new MemorySeenStore(max);
    if (!data || typeof data !== 'object') return s;
    if (Number.isSafeInteger(data.sync)) s.sync = data.sync!;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    for (const id of strings(data.ids)) s.add(id);
    for (const id of strings(data.wraps)) s.addWrap(id);
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
  private sub: { close(): void } | undefined;
  /** Resolves once every own relay caught up after the last `start()`. */
  private backlog: Promise<void> | undefined;
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
    this.sub = this.pool.subscribe(this.opts.ownRelays, {
      filter: (relay) => ({ kinds: [GIFT_WRAP_KIND], '#p': [this.selfKey], since: this.sinceFor(relay) }),
      onEvent: (event) => this.handleWrap(event),
      onSynced: (relay) => {
        this.seen.setSyncedUntil(relay, this.nowS() - 60);
        if (pending.delete(relay) && pending.size === 0) backlogIn();
      },
    });
  }

  caughtUp(): Promise<void> {
    return this.backlog ?? Promise.resolve();
  }

  async stop(): Promise<void> {
    if (!this.sub) return;
    this.sub.close();
    this.sub = undefined;
  }

  /** Stops for good: wipes the key copy and closes the relay connections it opened itself. */
  async dispose(): Promise<void> {
    await this.stop();
    if (this.disposed) return;
    this.disposed = true;
    this.secretKey.fill(0);
    this.refused.clear();
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
    if (this.disposed || this.refused.size === 0) return;
    const now = this.now();
    for (const [rumorId, r] of [...this.refused]) {
      if (!this.refused.has(rumorId)) continue;
      if (r.until < now || this.seen.has(rumorId)) {
        this.refused.delete(rumorId);
        continue;
      }
      if (this.opts.accept && !this.opts.accept(r.from, r.message)) continue;
      this.refused.delete(rumorId);
      this.seen.addWrap(r.wrapId);
      this.deliver(rumorId, r.from, r.message);
    }
  }

  private nowS(): number {
    return Math.floor(this.now() / 1000);
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

  /** Like nostr-tools' createWrap, plus a NIP-40 expiration so relays can delete it. */
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
          ['expiration', String(createdAt + WRAP_BACKDATE_S + RELAY_RETENTION_S)],
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
      if (this.seen.hasWrap(event.id)) return;
      for (const r of this.refused.values()) if (r.wrapId === event.id) return;
      const nowS = this.nowS();
      // The message inside is at most WRAP_BACKDATE_S newer than its wrap: this one can only hold an expired one.
      if (event.created_at + WRAP_BACKDATE_S < nowS - this.maxAge) return;
      if (!event.tags.some((t) => t[0] === 'p' && t[1] === this.selfKey)) return;
      if (!verifyEvent(event)) return;
      // From here the id is the wrap's own hash, so recording it cannot hide a different wrap.
      verified = true;
      if (this.open(event, nowS)) this.seen.addWrap(event.id);
    } catch (error) {
      // Undecryptable or malformed wraps are expected noise on public relays, and stay so.
      if (verified) this.seen.addWrap(event.id);
      this.opts.onError?.(error);
    }
  }

  /** Unwraps and hands the message on. False if the wrap may be worth another look later. */
  private open(event: NostrEvent, nowS: number): boolean {
    // Checks the seal signature and that the inner author matches the seal signer.
    const rumor = unwrapEvent(event, this.secretKey);
    if (rumor.kind !== APP_RUMOR_KIND || typeof rumor.content !== 'string' || !Number.isSafeInteger(rumor.created_at)) return true;
    // The rumor is unsigned: its id is a fair key for "already processed" only if it is its hash.
    if (getEventHash(rumor) !== rumor.id) return true;
    if (rumor.created_at < nowS - this.maxAge) return true;
    if (rumor.created_at > nowS + MAX_CLOCK_SKEW_S) return false;
    if (this.seen.has(rumor.id)) return true;

    // Only messages the app would act on take room in the bounded seen store.
    const parsed = parseAppMessage(rumor.content);
    // Perhaps a kind of message from a newer version: worth another look after an update.
    if (!parsed.ok) return false;
    if (this.opts.accept && !this.opts.accept(rumor.pubkey, parsed.message)) {
      this.holdRefused(rumor.id, { wrapId: event.id, from: rumor.pubkey, message: parsed.message, until: this.now() + REFUSED_TTL_MS, chars: rumor.content.length });
      return false;
    }
    this.deliver(rumor.id, rumor.pubkey, parsed.message);
    return true;
  }

  private deliver(rumorId: string, from: ContactKey, message: AppMessage): void {
    this.seen.add(rumorId);
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
