import {
  parseAppMessage,
  serializeAppMessage,
  type Acceptance,
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
 * Extra look-back before the last full sync of a relay, for senders whose clock runs a little
 * behind. A contact whose clock is known to run further behind widens it (see `clockLag`), so
 * every reconnect still fetches only the last few hours, not days.
 */
const SYNC_MARGIN_S = 3600;
/** The most a contact's lagging clock widens a catch-up: a clock set a day wrong is a mistake to fix, not to follow. */
const MAX_CLOCK_LAG_S = 24 * 3600;
/** Per sender, the lag of this many recent live messages; their median counts, so one late arrival changes nothing. */
const LAG_SAMPLES = 5;
const MAX_LAG_SENDERS = 100;
/** A sender's lag is forgotten when nothing came from them live for this long. */
const LAG_KEEP_S = 8 * 24 * 3600;
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
 * Contacts' messages held until the app can take them (see `NostrTransportOptions.accept`). Saved,
 * and apart from strangers' messages: a flood from throwaway keys cannot push them out. Per sender
 * and in all, so one contact cannot push out what waits for another either.
 */
const MAX_HELD = 500;
const MAX_HELD_PER_SENDER = 50;
const MAX_HELD_CHARS = 500_000;
const MAX_HELD_CHARS_PER_SENDER = 100_000;

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
  /**
   * Optional: a message from an accepted sender came live at `atS` (my clock), `lagS` seconds after
   * the time their clock gave it. Remembered, so catch-ups look back far enough for them.
   */
  noteClockLag?(sender: string, lagS: number, atS: number): void;
  /** Optional: how far (seconds, at most a day) the clock of the sender who lags most runs behind mine; 0 if none does. */
  clockLag?(nowS: number): number;
  /** Optional, with `heldMessages` and `release`: keeps held messages across restarts (see `HeldMessage`). */
  hold?(entry: HeldMessage): void;
  /** What is held, oldest first. */
  heldMessages?(): HeldMessage[];
  /** Forgets a held message: handed over, or no longer wanted. */
  release?(rumorId: string): void;
}

/** A contact's message held until the app can take it (a group text before its roster, an SOS update before the SOS). */
export interface HeldMessage {
  /** The rumor id. */
  id: string;
  wrap: string;
  /** For the seen store, once handed over. */
  wrapUntil: number;
  /** Epoch seconds: from then on it is too old to take, and goes. */
  keepUntil: number;
  from: string;
  /** The rumor's content, checked again when offered. */
  content: string;
}

/** Held messages, oldest first, within their budgets (see `MAX_HELD`). */
class HeldList {
  private readonly items = new Map<string, HeldMessage>();
  hold(entry: HeldMessage): void {
    if (this.items.has(entry.id)) return;
    this.items.set(entry.id, entry);
    // First the sender's own budget: only their oldest go.
    let theirs = this.heldMessages().filter((h) => h.from === entry.from);
    while (theirs.length > MAX_HELD_PER_SENDER || heldChars(theirs) > MAX_HELD_CHARS_PER_SENDER) {
      this.items.delete(theirs[0]!.id);
      theirs = theirs.slice(1);
    }
    // Then the total: the oldest of whoever holds the most gives way.
    while (this.items.size > MAX_HELD || heldChars(this.heldMessages()) > MAX_HELD_CHARS) {
      const per = new Map<string, number>();
      for (const h of this.items.values()) per.set(h.from, (per.get(h.from) ?? 0) + h.content.length);
      const most = [...per].sort((a, b) => b[1] - a[1])[0]![0];
      this.items.delete(this.heldMessages().find((h) => h.from === most)!.id);
    }
  }
  heldMessages(): HeldMessage[] {
    return [...this.items.values()];
  }
  release(rumorId: string): void {
    this.items.delete(rumorId);
  }
  prune(nowS: number): void {
    for (const [id, h] of [...this.items]) if (h.keepUntil < nowS) this.items.delete(id);
  }
}

const heldChars = (list: HeldMessage[]) => list.reduce((n, h) => n + h.content.length, 0);

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
  /** Per sender: recent clock lags (seconds) and when the last one came (epoch seconds). */
  lags?: [string, number[], number][];
  held?: HeldMessage[];
}

const MAX_RELAY_ENTRIES = 32;
const MAX_JUNK = 5000;
/** Only against running out of memory, should full saves fail for long: past it, the oldest go. */
const MAX_JOURNAL = 60_000;
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
  get(id: string): number | undefined {
    return this.ids.get(shortId(id));
  }
  /** Whether it changed anything. */
  add(id: string, keepUntil: number): boolean {
    const key = shortId(id);
    const until = Number.isFinite(keepUntil) ? Math.floor(keepUntil) : 0;
    if ((this.ids.get(key) ?? -Infinity) >= until) return false;
    this.ids.set(key, until);
    if (this.ids.size > this.cap) this.drop(this.ids.size - Math.floor(this.cap * 0.9), Infinity);
    return true;
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

const timedEntries = (v: unknown): [string, number][] =>
  Array.isArray(v) ? v.filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number') : [];

/** In memory; the app persists it via its own storage. */
export class MemorySeenStore implements SeenStore {
  private sync = 0;
  private readonly relays = new Map<string, number>();
  private readonly ids: TimedIds;
  private readonly wraps: TimedIds;
  private readonly junk = new TimedIds(0, MAX_JUNK);
  private readonly lags = new Map<string, { samples: number[]; at: number }>();
  private readonly held = new HeldList();
  /**
   * Ids added since the last full save (see `journal`), by list and short id, with the order they
   * came in. The app saves them with every change, so the full store can be written rarely.
   */
  private readonly recent = new Map<string, number>();
  private seq = 0;
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
    if (this.ids.add(id, keepUntil)) this.note('m', id);
  }
  hasWrap(id: string): boolean {
    return this.wraps.has(id) || this.junk.has(id);
  }
  addWrap(id: string, keepUntil: number): void {
    if (this.wraps.add(id, keepUntil)) this.note('w', id);
  }
  addJunk(id: string, keepUntil: number): void {
    if (this.junk.add(id, keepUntil)) this.note('j', id);
  }

  /**
   * The ids added since the last full save that `saved` confirmed: small, for the app to save with
   * every change. After a crash, `restore` of the last full save plus `merge` of this knows every
   * message handed over before the app data was saved, so none comes twice and none is lost.
   */
  journal(): SeenSnapshot {
    const out: Required<Pick<SeenSnapshot, 'messageIds' | 'wrapIds' | 'junkIds'>> = { messageIds: [], wrapIds: [], junkIds: [] };
    for (const key of this.recent.keys()) {
      const id = key.slice(1);
      const [list, entries] =
        key[0] === 'm' ? [this.ids, out.messageIds] : key[0] === 'w' ? [this.wraps, out.wrapIds] : [this.junk, out.junkIds];
      const until = list.get(id);
      if (until !== undefined) entries.push([id, until]);
    }
    return { sync: 0, ids: [], ...out };
  }
  journalSize(): number {
    return this.recent.size;
  }
  /** Take it together with a full `snapshot()`, and pass it to `saved` once that snapshot is written. */
  journalMark(): number {
    return this.seq;
  }
  /** The full snapshot taken at `mark` is written: what the journal held up to then is in it. */
  saved(mark: number): void {
    for (const [key, seq] of [...this.recent]) if (seq <= mark) this.recent.delete(key);
  }
  /** Adds what a journal saved with the app data holds (after `restore` of the full save). */
  merge(data: Partial<SeenSnapshot> | undefined): void {
    if (!data || typeof data !== 'object') return;
    for (const [id, until] of timedEntries(data.messageIds)) this.add(id, until);
    for (const [id, until] of timedEntries(data.wrapIds)) this.addWrap(id, until);
    for (const [id, until] of timedEntries(data.junkIds)) this.addJunk(id, until);
  }

  private note(list: 'm' | 'w' | 'j', id: string): void {
    const key = list + shortId(id);
    this.recent.delete(key);
    this.recent.set(key, ++this.seq);
    if (this.recent.size > MAX_JOURNAL) this.recent.delete(this.recent.keys().next().value!);
  }
  prune(nowS: number): void {
    this.ids.prune(nowS);
    this.wraps.prune(nowS);
    this.junk.prune(nowS);
    for (const [sender, l] of [...this.lags]) if (nowS - l.at > LAG_KEEP_S) this.lags.delete(sender);
    this.held.prune(nowS);
  }
  hold(entry: HeldMessage): void {
    this.held.hold(entry);
  }
  heldMessages(): HeldMessage[] {
    return this.held.heldMessages();
  }
  release(rumorId: string): void {
    this.held.release(rumorId);
  }
  noteClockLag(sender: string, lagS: number, atS: number): void {
    if (!Number.isFinite(lagS) || !Number.isSafeInteger(atS)) return;
    const samples = [...(this.lags.get(sender)?.samples ?? []), Math.round(lagS)].slice(-LAG_SAMPLES);
    this.lags.delete(sender);
    this.lags.set(sender, { samples, at: atS });
    if (this.lags.size > MAX_LAG_SENDERS) this.lags.delete(this.lags.keys().next().value!);
  }
  clockLag(nowS: number): number {
    let most = 0;
    for (const { samples, at } of this.lags.values()) {
      if (nowS - at > LAG_KEEP_S || !samples.length) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      most = Math.max(most, sorted[Math.floor(sorted.length / 2)]!);
    }
    return Math.min(most, MAX_CLOCK_LAG_S);
  }
  snapshot(): SeenSnapshot {
    return {
      sync: this.sync,
      ids: [],
      relays: Object.fromEntries(this.relays),
      messageIds: this.ids.entries(),
      wrapIds: this.wraps.entries(),
      junkIds: this.junk.entries(),
      lags: [...this.lags].map(([sender, l]) => [sender, [...l.samples], l.at]),
      held: this.held.heldMessages(),
    };
  }
  /** Tolerates data from older versions and anything malformed. */
  static restore(data: Partial<SeenSnapshot> | undefined, keep?: number, keepWraps?: number): MemorySeenStore {
    const s = new MemorySeenStore(keep, keepWraps);
    if (!data || typeof data !== 'object') return s;
    if (Number.isSafeInteger(data.sync)) s.sync = data.sync!;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    // Saved without a time: they count as expired, the first to go once more than `keep` are stored.
    for (const id of strings(data.ids)) s.ids.add(id, 0);
    for (const id of strings(data.wraps)) s.wraps.add(id, 0);
    // Straight into the lists: what a full save holds needs no journal entry.
    for (const [id, until] of timedEntries(data.messageIds)) s.ids.add(id, until);
    for (const [id, until] of timedEntries(data.wrapIds)) s.wraps.add(id, until);
    for (const [id, until] of timedEntries(data.junkIds)) s.junk.add(id, until);
    for (const entry of Array.isArray(data.lags) ? data.lags.slice(-MAX_LAG_SENDERS) : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1]) || !Number.isSafeInteger(entry[2])) continue;
      const samples = entry[1].filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).slice(-LAG_SAMPLES);
      if (samples.length) s.lags.set(entry[0], { samples, at: entry[2] });
    }
    for (const h of Array.isArray(data.held) ? data.held : []) {
      if (!h || typeof h !== 'object') continue;
      const { id, wrap, wrapUntil, keepUntil, from, content } = h as Partial<HeldMessage>;
      if (typeof id !== 'string' || typeof wrap !== 'string' || typeof from !== 'string' || typeof content !== 'string') continue;
      if (!Number.isSafeInteger(wrapUntil) || !Number.isSafeInteger(keepUntil)) continue;
      s.held.hold({ id, wrap, wrapUntil: wrapUntil!, keepUntil: keepUntil!, from, content });
    }
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
   * Whether the app acts on a message from this sender at all (`SocialNode.judgeMessage`; `true`
   * and `false` mean accept and refuse). Messages not accepted are not recorded as processed.
   * Without it a stranger who knows my key can flood the bounded seen store until real ids fall
   * out, then re-publish old wraps (anyone can fetch them from public relays) to have them handled
   * again. Held ones (a contact's message that waits for something) are kept in the seen store,
   * refused ones for a while in memory; both are offered again by `redeliverRefused()`.
   */
  accept?: (from: ContactKey, message: AppMessage) => Acceptance | boolean;
}

interface Refused {
  wrapId: string;
  /** For the seen store, once handed over. */
  wrapUntil: number;
  keepUntil: number;
  from: ContactKey;
  /** The rumor's content, parsed again when offered. */
  content: string;
  until: number;
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
  /** Messages `accept` refused, by rumor id, oldest first. Only in memory: mostly strangers'. */
  private readonly refused = new Map<string, Refused>();
  /** Messages `accept` wants held: the seen store's list when it keeps one, so they survive a restart. */
  private readonly held: Pick<HeldList, 'hold' | 'heldMessages' | 'release'>;
  /** Short ids of wraps turned away for now (see `MAX_LATER`), oldest first. */
  private readonly later = new Set<string>();
  private prunedAt: number | undefined;
  private sub: { close(): void } | undefined;
  /** Resolves once every own relay caught up after the last `start()`. */
  private backlog: Promise<void> | undefined;
  /** Waits from `caughtUpAgain()`: the own relays each still has to report caught up. */
  private readonly resyncs = new Set<{ pending: Set<string>; done: () => void }>();
  /** Per own relay: since when (ms) its live stream has run without a gap, from its first full catch-up on. */
  private readonly liveFrom = new Map<string, number>();
  private disposed = false;

  constructor(private readonly opts: NostrTransportOptions) {
    // A copy, kept for every later send and decryption: the app wipes the array it passed in.
    this.secretKey = Uint8Array.from(opts.secretKey);
    this.selfKey = getPublicKey(this.secretKey);
    this.ownsPool = !opts.pool;
    this.pool = opts.pool ?? new SimpleRelayPool();
    this.seen = opts.seen ?? new MemorySeenStore();
    const s = this.seen;
    this.held =
      s.hold && s.heldMessages && s.release
        ? { hold: (e) => s.hold!(e), heldMessages: () => s.heldMessages!(), release: (id) => s.release!(id) }
        : new HeldList();
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
      onEvent: (event, live) => this.handleWrap(event, live),
      handled: (id) => this.handled(id),
      onSynced: (relay) => {
        if (!this.liveFrom.has(relay)) this.liveFrom.set(relay, this.now());
        this.seen.setSyncedUntil(relay, this.nowS() - 60);
        this.pruneSeen();
        if (pending.delete(relay) && pending.size === 0) backlogIn();
        for (const r of [...this.resyncs]) {
          if (r.pending.delete(relay) && r.pending.size === 0) r.done();
        }
      },
      onLost: (relay) => this.liveFrom.delete(relay),
    });
    // What waited when the app last stopped may be wanted now (it stopped before offering it).
    this.offerHeld();
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

  /**
   * Since when every own relay has handed over new messages live without a gap (epoch ms, my
   * clock), counted from each one's last full catch-up; undefined while one has not, or stopped.
   */
  liveSince(): number | undefined {
    if (!this.sub) return undefined;
    let since: number | undefined;
    for (const relay of new Set(this.opts.ownRelays)) {
      const from = this.liveFrom.get(relay);
      if (from === undefined) return undefined;
      since = Math.max(since ?? from, from);
    }
    return since;
  }

  async stop(): Promise<void> {
    if (!this.sub) return;
    this.sub.close();
    this.sub = undefined;
    this.liveFrom.clear();
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
    this.offerHeld();
    const now = this.now();
    for (const [rumorId, r] of [...this.refused]) {
      if (!this.refused.has(rumorId)) continue;
      const parsed = parseAppMessage(r.content);
      if (r.until < now || this.seen.has(rumorId) || !parsed.ok) {
        this.refused.delete(rumorId);
        continue;
      }
      const verdict = this.judge(r.from, parsed.message);
      if (verdict === 'refuse') {
        this.markLater(r.wrapId);
        continue;
      }
      this.refused.delete(rumorId);
      if (verdict === 'hold') {
        // From a contact now (my other device's sync came), but it waits for something.
        this.held.hold({ id: rumorId, wrap: r.wrapId, wrapUntil: r.wrapUntil, keepUntil: r.keepUntil, from: r.from, content: r.content });
        this.markLater(r.wrapId);
        continue;
      }
      this.seen.addWrap(r.wrapId, r.wrapUntil);
      this.deliver(rumorId, r.keepUntil, r.from, parsed.message);
    }
  }

  /** Hands on the held messages the app takes now; drops those too old, or from someone no longer a contact. */
  private offerHeld(): void {
    const nowS = this.nowS();
    for (const h of this.held.heldMessages()) {
      const parsed = parseAppMessage(h.content);
      if (h.keepUntil < nowS || this.seen.has(h.id) || !parsed.ok) {
        this.held.release(h.id);
        continue;
      }
      const verdict = this.judge(h.from, parsed.message);
      if (verdict === 'hold') {
        this.markLater(h.wrap);
        continue;
      }
      this.held.release(h.id);
      if (verdict === 'refuse') continue;
      this.seen.addWrap(h.wrap, h.wrapUntil);
      this.deliver(h.id, h.keepUntil, h.from, parsed.message);
    }
  }

  private judge(from: ContactKey, message: AppMessage): Acceptance {
    const verdict = this.opts.accept ? this.opts.accept(from, message) : true;
    return verdict === true ? 'accept' : verdict === false ? 'refuse' : verdict;
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
    if (this.held instanceof HeldList) this.held.prune(nowS);
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
    // Their created_at comes from the sender's clock: a contact known to lag widens the window.
    const lag = Math.min(MAX_CLOCK_LAG_S, Math.max(0, this.seen.clockLag?.(nowS) ?? 0));
    return Math.max(0, oldestUseful, synced - WRAP_BACKDATE_S - SYNC_MARGIN_S - lag);
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

  private handleWrap(event: NostrEvent, live = false): void {
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
      const outcome = this.open(event, nowS, live);
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
  private open(event: NostrEvent, nowS: number, live = false): 'done' | 'junk' | 'later' {
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
    const verdict = this.judge(rumor.pubkey, parsed.message);
    if (verdict === 'hold') {
      this.held.hold({ id: rumor.id, wrap: event.id, wrapUntil: this.wrapUntil(event), keepUntil, from: rumor.pubkey, content: rumor.content });
      return 'later';
    }
    if (verdict === 'refuse') {
      this.holdRefused(rumor.id, {
        wrapId: event.id,
        wrapUntil: this.wrapUntil(event),
        keepUntil,
        from: rumor.pubkey,
        content: rumor.content,
        until: this.now() + REFUSED_TTL_MS,
      });
      return 'later';
    }
    // Sent just now by their clock's reckoning: how far that clock runs behind mine.
    if (live) this.seen.noteClockLag?.(rumor.pubkey, nowS - rumor.created_at, nowS);
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
    for (const r of this.refused.values()) chars += r.content.length;
    while (this.refused.size > MAX_REFUSED || chars > MAX_REFUSED_CHARS) {
      const [oldest, r] = this.refused.entries().next().value!;
      this.refused.delete(oldest);
      chars -= r.content.length;
    }
  }
}

function secureRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}
