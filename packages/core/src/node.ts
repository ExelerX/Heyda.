import { AutomationEngine, systemLocalTime, type ActionIntent, type AutomationEvent, type LocalTime } from './automation/engine';
import type { Rule } from './automation/schema';
import { checkinText, pingText } from './features/labels';
import { isLiveShareActive, isSosLocationActive, LIVE_CADENCE, LiveTracker, SOS_CADENCE, SOS_LOCATION_MS } from './features/live';
import { CLOCK_TOLERANCE_MS, normalizeFix, normalizeFixes } from './geo/fix';
import { GeofenceTracker, type Place } from './geo/geofence';
import type { LatLon, LocationFix } from './geo/types';
import { alertLevel, dndEndsAt, isDndActive, normalizePrefs, type AlertLevel, type NotificationPrefs } from './notify/prefs';
import { decodeInvite, encodeInvite, INVITE_TTL_MS } from './pairing/invite';
import { snapToGrid } from './privacy/coarse-grid';
import { PrivacyPolicy, type PlaceGrant } from './privacy/policy';
import { composeMessage } from './protocol/compose';
import {
  isSendable,
  MAX_GROUP_MEMBERS,
  RelayUrl,
  type AppMessage,
  type AppMessageBody,
  type BodyOf,
  type CheckinKind,
  type MessageOf,
  type PingKind,
  type Point,
} from './protocol/messages';
import { createSession, isSessionActive, type SessionLevel, type SharingSession } from './session/session';
import { TripSharer, type TripOptions } from './session/trip';
import {
  capGroups,
  contactLabel,
  type Alert,
  type Contact,
  type ContactStatus,
  type DeviceKind,
  type Group,
  type GroupMember,
  type LinkedDevice,
  type MySos,
  type MyWatch,
  type LiveShare,
  type LocationNeeds,
  type MyStatus,
  type NodeState,
  type OutboxEntry,
  type SyncField,
  type ChatEntry,
  type Alarm,
} from './state';
import { buildSyncDoc, mergeSyncDoc, parseSyncDoc } from './sync/doc';
import { decodeLinkInvite, LINK_SECRET_BYTES, LINK_TTL_MS, linkCode, linkCommitment, randomLinkSecret, type LinkInvite } from './sync/link';
import { chunkPayload, Reassembler } from './sync/xfer';
import type { ContactKey, IncomingMessage, Transport } from './transport/transport';
import { base64urlDecode, base64urlEncode } from './util/base64url';
import { RateLimiter, RecentIds } from './util/rate-limit';
import { randomId } from './util/random';

export type NodeEvent =
  | { type: 'contact.added'; contact: Contact }
  /** What a contact shares with me changed. */
  | { type: 'status'; contact: ContactKey; status: ContactStatus }
  /** A new line in a chat: incoming, sent by me, or sent from another of my devices. */
  | { type: 'chat'; thread: string; entry: ChatEntry }
  /** Something to show: as a notification (by `level`) and in the activity list. */
  | { type: 'alert'; alert: Alert }
  /** A notification the OS should fire at a set time, even if the app is closed by then. */
  | { type: 'alarm.schedule'; alarm: Alarm }
  | { type: 'alarm.cancel'; id: string }
  | { type: 'trip'; session: SharingSession | undefined }
  /** Which location tracking the platform should run now. */
  | { type: 'location'; needs: LocationNeeds }
  | { type: 'state'; state: NodeState }
  /** The device link this device is sending its account through changed (see `linkStatus`). */
  | { type: 'link'; status: LinkStatus | undefined };

/**
 * Where linking a new device stands on the existing device: waiting for the new device to
 * answer, or showing the 6 digits the person compares before the account is sent.
 */
export type LinkStatus = { phase: 'waiting'; expiresAt: number } | { phase: 'compare'; code: string; expiresAt: number };

/** The one device link in progress on the existing device. Lives only in memory. */
interface PendingLink {
  invite: LinkInvite;
  /** My random share. Wiped once the digits are known. */
  rE: Uint8Array;
  startedAt: number;
  /**
   * When it ends: the code's expiry, but never later than `LINK_TTL_MS` after the scan by my
   * own clock, since the code's expiry comes from the new device's clock.
   */
  expiresAt: number;
  /** Set once the new device's reveal opened its commitment. */
  code?: string;
  sending?: boolean;
  /**
   * The account in chunks, made on the first "yes" and sent again as they are on a retry: one
   * transfer, so chunks that arrived on an earlier try still count. Dropped with the session.
   */
  chunks?: BodyOf<'xfer.chunk'>[];
}

export interface SocialNodeOptions {
  transport: Transport;
  initialState: NodeState;
  /** Statuses saved from the last run, so the home screen is not empty after a restart. */
  initialStatuses?: Record<ContactKey, ContactStatus>;
  now?: () => number;
  localTime?: (now: number) => LocalTime;
  tripOptions?: TripOptions;
  /** Delay before changed settings go to my other devices. 0: only on `tick()` / `flushSync()`. */
  syncDelayMs?: number;
  /** What this device is (see `runsAutomationActions`). Default: phone. */
  deviceKind?: DeviceKind;
  /** How long `start()` waits at most for what waited on the relays (see `whenCaughtUp`). For tests. */
  backlogWaitMs?: number;
}

/** How long relays should keep a message for an offline phone, in seconds. */
export const TTL = {
  chat: 7 * 24 * 3600,
  trip: 6 * 3600,
  place: 24 * 3600,
  presence: 24 * 3600,
  live: 3600,
  sos: 3 * 24 * 3600,
  sync: 7 * 24 * 3600,
  link: 15 * 60,
} as const;

export const MAX_CONTACTS = 500;
export const MAX_GROUPS = 100;
export const MAX_OPEN_INVITES = 10;
export const MAX_WATCH_MS = 48 * 3600_000;
export const MIN_WATCH_MS = 5 * 60_000;
const MAX_OUTBOX = 500;
const MAX_WATCHES_PER_CONTACT = 10;
const MAX_OWN_WATCHES = 20;
const MAX_SOS_ACKS = 50;
/** Sender clocks are trusted for ordering only up to this far ahead of mine. */
const MAX_CLOCK_AHEAD_MS = 10 * 60_000;
/** How far ahead of my clock a contact's last message time may be and still order their updates. */
const ORDER_TRUST_AHEAD_MS = 60_000;
const FRESH_FIX_MS = 2 * 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** How long after its deadline a contact's watch is still taken, and its status kept. */
const WATCH_KEEP_MS = 12 * HOUR;
/** A watch that arrives after its deadline rings this long after it came, so a check-in caught up with it can still cancel it. */
const LATE_WATCH_GRACE_MS = 2 * 60_000;
/** Loud watch alarms (they ring through quiet mode) one contact may have ringing within an hour of each other. */
const LOUD_WATCHES_PER_HOUR = 4;
/** Queued messages tried first after being offline: someone may be waiting for them in an emergency. */
const PRIORITY_TYPES = new Set(['sos.start', 'sos.update', 'sos.end', 'sos.ack', 'watch.start', 'watch.end', 'where.reply']);
/** Failed sends to this many different people in a row, with no success in between, mean I am offline. */
const OFFLINE_AFTER_FAILURES = 3;

/** Messages sent this long before this device got the account still count as new: senders' clocks differ a little. */
const HISTORY_MARGIN_MS = 5 * 60_000;
/** An open SOS sent before this device got the account rings this long after it came, unless its end follows. */
const HISTORY_SOS_WAIT_MS = 2 * 60_000;
/** How long a contact's SOS that was never ended is kept. */
const SOS_KEEP_MS = 3 * DAY;
/**
 * How long a start waits at most for what relays kept while the device was off, before deadlines
 * that passed meanwhile ring anyway. Shorter than a background wake listens (20 s).
 */
const BACKLOG_WAIT_MS = 15_000;

/** Message types whose newer copy replaces an older one still waiting in the outbox. */
const REPLACEABLE = new Set(['presence', 'session.update', 'live.update', 'sos.update']);
/** Queued messages that tell where I am or was. Ghost mode and ending a share drop them. */
const LOCATION_TYPES = new Set(['session.update', 'live.update', 'place.event']);
/** Every message that may carry where I am. Never sent to someone who stopped being a contact after it was queued. */
const CARRIES_LOCATION = new Set([...LOCATION_TYPES, 'where.reply', 'sos.start', 'sos.update']);
/** Ends of what someone sees from me. Still sent after I removed them, so nothing stays open on their phone. */
const END_TYPES = new Set(['live.end', 'session.end', 'watch.end', 'sos.end']);

/** A map link for a location, for phones without the app. */
export function osmLink(p: LatLon): string {
  const lat = p.lat.toFixed(5);
  const lon = p.lon.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}

/** Text for the SMS fallback of an SOS, for people without internet or without the app. */
export function sosFallbackText(name: string, text: string | undefined, point: LatLon | undefined): string {
  const lines = [`🆘 ${name} braucht Hilfe!`];
  if (text?.trim()) lines.push(text.trim());
  if (point) lines.push(`Standort: ${osmLink(point)}`);
  lines.push('(gesendet mit Heyda.)');
  return lines.join('\n');
}

/**
 * Everything one device does, without any platform code: contacts, trips, live location,
 * check-ins, watches, SOS, groups, quiet mode, automations and syncing my own devices.
 *
 * The UI calls methods here and listens to `NodeEvent`s. The platform layer feeds location
 * fixes, calls `tick()` regularly, shows alerts as notifications and schedules alarms.
 */
export class SocialNode {
  private state: NodeState;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly localTime: (now: number) => LocalTime;
  private readonly policy: PrivacyPolicy;
  private readonly geofence: GeofenceTracker;
  private readonly engine: AutomationEngine;
  private readonly listeners = new Set<(e: NodeEvent) => void>();
  private readonly statuses = new Map<ContactKey, ContactStatus>();
  private readonly seen = new RecentIds(5000);
  private readonly reassembler = new Reassembler(4);
  private readonly preciseTracker = new LiveTracker(LIVE_CADENCE);
  private readonly coarseTracker = new LiveTracker(LIVE_CADENCE);
  private readonly sosTracker = new LiveTracker(SOS_CADENCE);
  /** My clock at the last tick or fix, to notice it jumping back. */
  private lastNow = 0;
  /** Trips, live shares, watches and SOS alerts that ended, so late messages can't revive them. */
  private readonly ended = new RecentIds(1000);
  /** Per sender: notifications in a short window. More only land in the activity list. */
  private readonly alertLimiter = new RateLimiter(20, 10 * 60_000);
  private readonly urgentLimiter = new RateLimiter(3, HOUR);
  private readonly sosAlarmLimiter = new RateLimiter(6, HOUR);
  private readonly whereLimiter = new RateLimiter(5, HOUR);
  private readonly askLimiter = new RateLimiter(5, HOUR);
  /**
   * Per contact: when their loud watch alarms ring (see `chargeLoudWatch`). A watch ended before
   * it rang keeps its place, so starting and ending watches over and over gains nothing.
   */
  private readonly loudWatchRings = new Map<ContactKey, { watchId: string; at: number }[]>();
  /** People the last try to send to failed while others could be reached. The outbox tries them last. */
  private readonly unreachable = new Set<ContactKey>();
  /** Per contact: name and relay changes, each of which is saved and synced to my other devices. */
  private readonly helloLimiter = new RateLimiter(10, HOUR);
  private trip: TripSharer | undefined;
  private lastFix: LocationFix | undefined;
  private unsubscribe: (() => void) | undefined;
  private lastPresence = '';
  private lastDndActive: boolean | undefined;
  private lastNeeds = '';
  private syncDue = false;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private flushingOutbox = false;
  private running = false;
  private redeliverQueued = false;
  private pendingLink: PendingLink | undefined;
  /**
   * False from `start()` until what waited on the relays while this device was off has arrived
   * (or BACKLOG_WAIT_MS passed). Until then watches and SOS alerts whose time passed meanwhile do
   * not ring: the check-in or end that calls them off may still be on its way.
   */
  private backlogIn = true;
  private backlogDone: Promise<void> = Promise.resolve();
  private backlogTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts starts, so a wait from an earlier run changes nothing. */
  private runs = 0;
  /**
   * Set while the synchronous part of handling a message sent before this device got the account
   * runs (see `NodeState.historyBefore`): `alert` and `runAutomations` then do nothing. Handlers
   * must raise alerts and start automations before their first `await` (they all do).
   */
  private replaying = false;

  constructor(private readonly options: SocialNodeOptions) {
    this.state = JSON.parse(JSON.stringify(options.initialState)) as NodeState;
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.localTime = options.localTime ?? systemLocalTime;
    this.policy = new PrivacyPolicy(() => this.state);
    this.geofence = new GeofenceTracker(this.state.places);
    this.engine = new AutomationEngine({
      rules: () => this.state.rules,
      contactName: (k) => this.name(k),
      // My nickname for someone stays on my devices: what goes to others uses their own name.
      sentName: (k) => this.contact(k)?.name ?? this.name(k),
      placeName: (id) => this.state.places.find((p) => p.id === id)?.name,
      isAtPlace: (id) => this.geofence.isInside(id),
      localTime: this.localTime,
    });
    for (const [key, status] of Object.entries(options.initialStatuses ?? {})) {
      if (this.contact(key) && status && typeof status === 'object') this.statuses.set(key, status);
    }
    // Loud alarms still to ring (or just rung) keep counting after a restart.
    for (const [key, status] of this.statuses) {
      const rings = (status.watches ?? []).filter((w) => !w.quiet).map((w) => ({ watchId: w.watchId, at: watchRingTime(w) }));
      if (rings.length) this.loudWatchRings.set(key, rings);
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.transport.onMessage((m) => {
      this.handleIncoming(m).catch(() => {
        // One bad message must never stop the others.
      });
    });
    await this.transport.start();
    this.awaitBacklog();
    this.lastDndActive = this.dndActive();
    this.emitLocationNeeds();
    // A computer waits for a phone it does not know about: let my other devices know what this one
    // is, so another computer can tell it need not wait (they answer with what they are).
    if (this.deviceKind === 'computer' && this.state.devices.some((d) => d.kind === undefined)) this.markSync();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    clearTimeout(this.backlogTimer);
    this.unsubscribe?.();
    await this.transport.stop();
  }

  /**
   * Resolves once what relays kept while this device was off has arrived, or the node stopped
   * waiting for it. Alarms whose time passed meanwhile are judged only then (an end or check-in
   * may be among it): the platform holds back its own copies of them until this resolves.
   */
  whenCaughtUp(): Promise<void> {
    return this.backlogDone;
  }

  private awaitBacklog(): void {
    const caughtUp = this.transport.caughtUp?.();
    if (!caughtUp) return;
    const run = ++this.runs;
    this.backlogIn = false;
    this.backlogDone = new Promise<void>((resolve) => {
      clearTimeout(this.backlogTimer);
      this.backlogTimer = setTimeout(resolve, this.options.backlogWaitMs ?? BACKLOG_WAIT_MS);
      caughtUp.then(resolve, resolve);
    }).then(() => {
      if (run !== this.runs) return;
      clearTimeout(this.backlogTimer);
      this.backlogIn = true;
      if (!this.running) return;
      this.ringMissed(this.now());
    });
  }

  /** Watches overdue and held SOS alerts whose wait is over: they ring now. */
  private ringMissed(now: number): void {
    // First what is too old to ring at all.
    this.pruneStatuses(now);
    if (!this.backlogIn) return;
    this.checkOverdueWatches(now);
    this.ringHeldSos(now);
  }

  on(listener: (e: NodeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): NodeState {
    return this.state;
  }

  getStatus(key: ContactKey): ContactStatus {
    return this.statuses.get(key) ?? {};
  }

  /** All statuses, for saving between runs. */
  exportStatuses(): Record<ContactKey, ContactStatus> {
    return Object.fromEntries(this.statuses);
  }

  get activeTrip(): SharingSession | undefined {
    return this.trip && !this.trip.isEnded ? this.trip.session : undefined;
  }

  /** The last rounded ETA my running trip sent. */
  get activeTripEta(): number | undefined {
    return this.activeTrip ? this.trip?.lastEtaMinutes : undefined;
  }

  /** Display name for a contact, a group member who is not a contact, or myself. */
  name(key: ContactKey): string {
    if (key === this.state.self.key) return this.state.self.name;
    const c = this.contact(key);
    if (c) return contactLabel(c);
    for (const g of this.state.groups) {
      const m = g.members.find((x) => x.key === key);
      if (m) return m.name;
    }
    return 'Unbekannt';
  }

  /** Relays to reach someone: theirs if a contact, otherwise from a group roster. */
  relaysFor(key: ContactKey): string[] {
    if (key === this.state.self.key) return this.state.self.relays;
    const c = this.contact(key);
    if (c?.relays.length) return c.relays;
    for (const g of this.state.groups) {
      const m = g.members.find((x) => x.key === key);
      if (m?.relays?.length) return m.relays;
    }
    return [];
  }

  isDndActive(): boolean {
    return this.dndActive();
  }

  /** When quiet mode ends, if it is on. `undefined` also means "until switched off". */
  dndEndsAt(): number | undefined {
    return this.dndActive() ? dndEndsAt(this.state.prefs.dnd, this.now(), this.localTime) : undefined;
  }

  locationNeeds(): LocationNeeds {
    const reasons: LocationNeeds['reasons'] = [];
    const now = this.now();
    if (this.activeTrip) reasons.push('trip');
    const live = this.state.ghost ? [] : this.state.liveShares.filter((s) => isLiveShareActive(s, now));
    if (live.length) reasons.push('live');
    if (this.state.sos && isSosLocationActive(this.sosWindow(this.state.sos, now), now)) reasons.push('sos');
    const high = reasons.includes('trip') || reasons.includes('sos') || live.some((s) => s.level === 'precise');
    return { mode: high ? 'high' : reasons.length ? 'low' : 'off', reasons };
  }

  /** The place I'm at right now, if any. */
  currentPlace(): Place | undefined {
    return this.state.places.find((p) => this.geofence.isInside(p.id));
  }

  /** The newest location fix, if it is recent enough to share. Never one from the future (the clock was set back since). */
  freshFix(maxAgeMs = FRESH_FIX_MS): LocationFix | undefined {
    if (!this.lastFix) return undefined;
    const age = this.now() - this.lastFix.timestamp;
    return age >= -CLOCK_TOLERANCE_MS && age < maxAgeMs ? this.lastFix : undefined;
  }

  // ---- profile and settings ------------------------------------------------------------------

  /** Changes my display name and tells all contacts. */
  async setProfileName(name: string): Promise<void> {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new RangeError('Der Name darf nicht leer sein.');
    this.update({ self: { ...this.state.self, name: clean } }, ['profile']);
    await this.sendMany(this.contactKeys(), { type: 'hello', name: clean, relays: this.state.self.relays }, TTL.chat);
  }

  setDeviceName(name: string): void {
    const clean = name.trim().slice(0, 40);
    if (clean) this.update({ self: { ...this.state.self, deviceName: clean } });
  }

  /** Ghost mode: no location leaves this device automatically. An SOS still sends it. */
  async setGhost(ghost: boolean): Promise<void> {
    if (ghost === this.state.ghost) return;
    this.update({ ghost });
    if (ghost) {
      // Also what was queued while offline, or it would still leave once the phone is back online.
      this.dropQueued((e) => LOCATION_TYPES.has(e.message.type));
      await this.stopLive();
      // A trip would keep GPS running and still announce the arrival.
      await this.stopTrip();
    }
    this.emitLocationNeeds();
  }

  setPlaces(places: Place[]): void {
    this.geofence.setPlaces(places);
    this.update({ places }, ['places']);
  }

  setGrants(grants: PlaceGrant[]): void {
    this.update({ grants }, ['grants']);
  }

  setRules(rules: Rule[]): void {
    this.update({ rules }, ['rules']);
  }

  setSosMessage(text: string | undefined): void {
    this.update({ sosMessage: text?.trim().slice(0, 200) || undefined }, ['sosMessage']);
  }

  async setPrefs(prefs: NotificationPrefs): Promise<void> {
    this.update({ prefs: normalizePrefs(prefs) }, ['prefs']);
    this.lastDndActive = this.dndActive();
    await this.broadcastPresence();
  }

  /** Quiet mode by hand: `0` turns it off, `undefined` keeps it on until turned off. */
  async setDnd(minutes: number | undefined): Promise<void> {
    const dnd = { ...this.state.prefs.dnd };
    if (minutes === 0) delete dnd.manual;
    else if (minutes === undefined) dnd.manual = {};
    else dnd.manual = { until: this.now() + Math.min(Math.max(1, Math.round(minutes)), 7 * 1440) * 60_000 };
    await this.setPrefs({ ...this.state.prefs, dnd });
  }

  /** A short status like "🎬 Im Kino", shown to my contacts until it expires. */
  async setMyStatus(status: { text?: string; emoji?: string; hours: number } | null): Promise<void> {
    let next: MyStatus | undefined;
    if (status) {
      const text = status.text?.trim().slice(0, 80) || undefined;
      const emoji = status.emoji?.trim().slice(0, 16) || undefined;
      if (!text && !emoji) throw new RangeError('Der Status braucht einen Text oder ein Emoji.');
      const hours = Math.min(Math.max(Number(status.hours) || 1, 0.25), 7 * 24);
      next = { text, emoji, expiresAt: this.now() + Math.round(hours * HOUR) };
    }
    this.update({ status: next }, ['status']);
    await this.broadcastPresence();
  }

  // ---- contacts ------------------------------------------------------------------------------

  /** Text for the QR code this device shows. */
  createInvite(): string {
    const now = this.now();
    const nonce = randomId();
    const expiresAt = now + INVITE_TTL_MS;
    const open = this.state.openInvites.filter((i) => i.expiresAt > now).slice(-(MAX_OPEN_INVITES - 1));
    this.update({ openInvites: [...open, { nonce, expiresAt }] });
    const { key, name, relays } = this.state.self;
    return encodeInvite({ key, name, relays, nonce, expiresAt });
  }

  /** Called with the text of a scanned QR code. */
  async acceptInvite(text: string): Promise<Contact> {
    const decoded = decodeInvite(text, this.now());
    if (!decoded.ok) throw new Error(inviteError(decoded.error));
    const { invite } = decoded;
    if (invite.key === this.state.self.key) throw new Error('Das ist dein eigener Code.');
    const contact = this.addContact({ key: invite.key, name: invite.name, relays: invite.relays });
    await this.sendTo(
      contact.key,
      { type: 'hello', name: this.state.self.name, relays: this.state.self.relays, inviteNonce: invite.nonce },
      TTL.chat,
    );
    return contact;
  }

  /** Changes my own settings for a contact. None of this is sent to them. */
  updateContact(
    key: ContactKey,
    patch: Partial<Pick<Contact, 'nickname' | 'favorite' | 'muted' | 'emergency' | 'phone'>>,
  ): void {
    const clean: Partial<Contact> = {};
    if ('nickname' in patch) clean.nickname = patch.nickname?.trim().slice(0, 40) || undefined;
    if ('favorite' in patch) clean.favorite = patch.favorite === true || undefined;
    if ('muted' in patch) clean.muted = patch.muted === true || undefined;
    if ('emergency' in patch) clean.emergency = patch.emergency === true || undefined;
    if ('phone' in patch) {
      const phone = patch.phone?.replace(/[^\d+]/g, '').slice(0, 32);
      clean.phone = phone && /^\+?\d{3,31}$/.test(phone) ? phone : undefined;
    }
    this.editContact(key, clean);
  }

  markVerified(key: ContactKey): void {
    this.editContact(key, { verified: true });
  }

  async removeContact(key: ContactKey): Promise<void> {
    const c = this.contact(key);
    if (!c) return;
    const ends = this.endEverythingWith(key);
    const grants = this.state.grants.filter((g) => g.contactKey !== key);
    this.update(
      {
        contacts: this.state.contacts.filter((x) => x.key !== key),
        // Later than the contact's last change even if another device's clock runs ahead, or the removal would lose.
        removedContacts: [...this.state.removedContacts.filter((t) => t.key !== key), { key, at: Math.max(this.now(), stampOf(c) + 1) }].slice(-1000),
        grants,
      },
      // Synced, so another device does not keep the grant and hand it back if they are added again.
      grants.length !== this.state.grants.length ? ['grants'] : [],
    );
    this.markSync();
    await ends;
  }

  /**
   * Someone stops being a contact, removed here or on another of my devices: what this device
   * still runs with them ends for them too. My live share, trip, watches and SOS get their end, so
   * their phone stops showing them and no watch alarm rings there later; nothing else still queued
   * for them goes out (group messages aside, they belong to the group), and their questions and
   * statuses are dropped. I leave the groups they own. Their relays are taken now, while they are
   * still known. Everything here changes at once; the returned promise settles when the ends went
   * out or were queued.
   */
  private endEverythingWith(key: ContactKey): Promise<void> {
    const relays = this.relaysFor(key);
    const ends: { body: AppMessageBody; ttl: number }[] = [];
    this.dropQueued((e) => e.to === key && !END_TYPES.has(e.message.type) && !e.message.type.startsWith('group.'));

    const shares = this.state.liveShares.filter((s) => s.contactKey === key);
    for (const s of shares) ends.push({ body: { type: 'live.end', shareId: s.shareId, reason: 'stopped' }, ttl: TTL.live });

    const watches: NodeState['watches'] = [];
    for (const w of this.state.watches) {
      if (!w.recipients.includes(key)) {
        watches.push(w);
        continue;
      }
      ends.push({ body: { type: 'watch.end', watchId: w.watchId, reason: 'cancelled' }, ttl: TTL.chat });
      const recipients = w.recipients.filter((k) => k !== key);
      if (recipients.length) watches.push({ ...w, recipients });
      else {
        this.emit({ type: 'alarm.cancel', id: `mywatch:${w.watchId}:remind` });
        this.emit({ type: 'alarm.cancel', id: `mywatch:${w.watchId}:due` });
      }
    }

    let sos = this.state.sos;
    if (sos?.recipients.includes(key)) {
      // The protocol knows no "removed": "cancelled" is the end that claims the least.
      ends.push({ body: { type: 'sos.end', sosId: sos.sosId, reason: 'cancelled' }, ttl: TTL.sos });
      const recipients = sos.recipients.filter((k) => k !== key);
      sos = recipients.length ? { ...sos, recipients, acks: sos.acks.filter((a) => a.key !== key) } : undefined;
    }

    // Groups they own: I leave them, or they would stay half working (neither they nor the people
    // only they vouched for reach me there any more, see `acceptsMessage`). Kept hidden with their
    // version (see `Group.dissolved`), so they can add me again once we are connected again.
    const now = this.now();
    const groups = this.state.groups.map((g) => {
      if (g.owner !== key || g.dissolved) return g;
      ends.push({ body: { type: 'group.leave', groupId: g.id }, ttl: TTL.chat });
      return { ...g, members: g.members.filter((m) => m.key === key), updatedAt: now, dissolved: true };
    });

    this.update({
      liveShares: this.state.liveShares.filter((s) => s.contactKey !== key),
      watches,
      sos,
      groups,
      whereInbox: this.state.whereInbox.filter((w) => w.from !== key),
      whereAsked: this.state.whereAsked.filter((w) => w.from !== key),
    });

    const trip = this.trip && !this.trip.isEnded && this.trip.session.recipients.includes(key) ? this.trip : undefined;
    if (trip) {
      ends.push({ body: { type: 'session.end', sessionId: trip.session.id, reason: 'stopped' }, ttl: TTL.trip });
      trip.dropRecipient(key);
      if (trip.session.recipients.length) this.emit({ type: 'trip', session: trip.session });
      else {
        // Nobody is left to get it, and it would keep the GPS running for nothing.
        trip.stopMessage();
        this.afterTripEnded();
      }
    }

    for (const w of this.statuses.get(key)?.watches ?? []) this.emit({ type: 'alarm.cancel', id: `watch:${key}:${w.watchId}` });
    this.statuses.delete(key);
    this.loudWatchRings.delete(key);
    this.emitLocationNeeds();
    return Promise.all(ends.map(({ body, ttl }) => this.deliver(key, composeMessage(body, this.now()), ttl, relays))).then(() => {});
  }

  // ---- trips ---------------------------------------------------------------------------------

  async startTrip(input: {
    recipients: ContactKey[];
    destinationName: string;
    destination?: LatLon;
    level?: SessionLevel;
    durationMs?: number;
  }): Promise<SharingSession> {
    if (this.state.ghost) throw new Error('Der Geistmodus ist an. Schalte ihn aus, um deinen Standort zu teilen.');
    const known = input.recipients.filter((k) => this.contact(k));
    if (!known.length) throw new RangeError('Wähle mindestens einen Kontakt.');
    if (this.activeTrip) await this.stopTrip();
    const session = createSession({ ...input, recipients: known, now: this.now() });
    this.trip = new TripSharer(session, this.options.tripOptions);
    await this.broadcastTrip(this.trip.startMessage());
    this.emit({ type: 'trip', session });
    this.emitLocationNeeds();
    // Send the first ETA right away if the location is known.
    const fix = this.freshFix();
    if (fix) await this.onTripFix({ ...fix, timestamp: this.now() });
    return session;
  }

  async stopTrip(): Promise<void> {
    if (!this.trip || this.trip.isEnded) return;
    this.dropQueuedTripUpdates(this.trip.session.id);
    await this.broadcastTrip(this.trip.stopMessage());
    this.afterTripEnded();
  }

  /**
   * Picks up a trip that was running before the app restarted. Sends nothing, with one exception:
   * when my clock was set back to before the trip started, the trip is over (as `tick()` decides
   * while the app runs), but my contacts would still see it running until its end. Then its end
   * goes out to them, and it is not picked up.
   */
  resumeTrip(session: SharingSession): boolean {
    if (this.state.ghost || this.activeTrip) return false;
    const now = this.now();
    const recipients = session.recipients.filter((k) => this.contact(k));
    if (!recipients.length || !isSessionActive(session, now)) this.dropQueuedTripUpdates(session.id);
    if (!recipients.length) return false;
    const trip = new TripSharer({ ...session, recipients }, this.options.tripOptions);
    if (!isSessionActive(session, now)) {
      // A trip that simply ran out ends for my contacts on its own too: they know `expiresAt`.
      if (session.endedAt === undefined && now < session.startedAt - CLOCK_TOLERANCE_MS) {
        this.trip = trip;
        for (const body of trip.expire(now)) void this.broadcastTrip(body).catch(() => {});
      }
      return false;
    }
    this.trip = trip;
    this.emit({ type: 'trip', session: this.trip.session });
    this.emitLocationNeeds();
    return true;
  }

  // ---- location ------------------------------------------------------------------------------

  /**
   * Feed every location fix from the OS here. Broken fixes are dropped (never thrown), and a fix
   * dated in the future counts as now (see `normalizeFix`).
   */
  async onLocationFix(raw: LocationFix): Promise<void> {
    const fix = normalizeFix(raw, this.now());
    if (fix) await this.takeFix(fix);
  }

  /**
   * Fixes the OS hands over together, oldest first. The same as `onLocationFix` for each, except
   * that a batch dated in the future moves back as a whole, so its newest position stays the
   * newest (see `normalizeFixes`).
   */
  async onLocationFixes(raw: readonly LocationFix[]): Promise<void> {
    for (const fix of normalizeFixes(raw, this.now())) await this.takeFix(fix);
  }

  /**
   * Notices my clock jumping back while the app runs and moves my own SOS location window
   * along, so it keeps its remaining time: a person in need whose wrong clock gets corrected
   * keeps sending their location, and a clock set back by hand cannot stretch the hour.
   * (After a restart the jump is not known; `isSosLocationActive` then ends the window.)
   */
  /** My SOS as `noteClock` will see it at `now` (for read-only checks between ticks). */
  private sosWindow(sos: MySos, now: number): MySos {
    const back = this.lastNow - now;
    return back > CLOCK_TOLERANCE_MS ? { ...sos, locationUntil: sos.locationUntil - back } : sos;
  }

  private noteClock(now: number): void {
    const back = this.lastNow - now;
    this.lastNow = now;
    if (back <= CLOCK_TOLERANCE_MS) return;
    const sos = this.state.sos;
    if (sos) this.update({ sos: { ...sos, locationUntil: sos.locationUntil - back } });
  }

  private async takeFix(fix: LocationFix): Promise<void> {
    const now = this.now();
    this.noteClock(now);
    // Out of order, unless the last fix now lies in the future: then the clock was set back, and
    // waiting for it to catch up would freeze location handling, so this fix becomes the reference.
    const last = this.lastFix;
    if (last && fix.timestamp < last.timestamp && last.timestamp <= now + CLOCK_TOLERANCE_MS) return;
    this.lastFix = fix;
    for (const ev of this.geofence.update(fix)) await this.handlePlaceEvent(ev.placeId, ev.type, ev.at);
    await this.onTripFix(fix);
    await this.sendLiveUpdates(fix);
    await this.sendSosUpdate(fix);
  }

  /** For arrive/leave detected natively by the OS (region monitoring), not from raw fixes. */
  async onPlaceTransition(placeId: string, type: 'arrive' | 'leave', at: number = this.now()): Promise<void> {
    if (!this.geofence.applyTransition(placeId, type === 'arrive')) return;
    await this.handlePlaceEvent(placeId, type, at);
  }

  /** Records where I am without announcing anything (initial state after registering geofences). */
  syncPlaceState(placeId: string, inside: boolean): void {
    this.geofence.applyTransition(placeId, inside);
  }

  private async onTripFix(fix: LocationFix): Promise<void> {
    if (!this.trip || this.trip.isEnded) return;
    const etaBefore = this.trip.lastEtaMinutes;
    // My clock decides when the trip is over (also after it was set back), not the fix's time.
    for (const body of [...this.trip.expire(this.now()), ...this.trip.onFix(fix)]) await this.broadcastTrip(body);
    if (this.trip.isEnded) this.afterTripEnded();
    // Screens show my own ETA too.
    else if (this.trip.lastEtaMinutes !== etaBefore) this.emit({ type: 'trip', session: this.trip.session });
  }

  private async handlePlaceEvent(placeId: string, type: 'arrive' | 'leave', at: number): Promise<void> {
    const place = this.state.places.find((p) => p.id === placeId);
    if (!place) return;
    await this.sendMany(
      this.policy.placeEventRecipients(place.id, this.now()),
      { type: 'place.event', kind: type, placeName: place.name },
      TTL.place,
    );
    await this.runAutomations({ type: type === 'arrive' ? 'me.arrive' : 'me.leave', placeId: place.id, at });
  }

  // ---- live location -------------------------------------------------------------------------

  /**
   * Shares my location continuously with some contacts. `coarse` sends a 2 km grid cell,
   * `precise` the exact point. Without `durationMs` it runs until I stop it.
   */
  async startLive(input: { contacts: ContactKey[]; level: 'coarse' | 'precise'; durationMs?: number }): Promise<void> {
    if (this.state.ghost) throw new Error('Der Geistmodus ist an. Schalte ihn aus, um deinen Standort zu teilen.');
    const now = this.now();
    const expiresAt = input.durationMs ? now + Math.min(Math.max(input.durationMs, 60_000), 30 * DAY) : undefined;
    const keys = [...new Set(input.contacts)].filter((k) => this.contact(k));
    if (!keys.length) throw new RangeError('Wähle mindestens einen Kontakt.');
    const replaced = this.state.liveShares.filter((s) => keys.includes(s.contactKey));
    const added: LiveShare[] = keys.map((contactKey) => ({
      shareId: randomId(),
      contactKey,
      level: input.level,
      startedAt: now,
      expiresAt,
    }));
    this.update({ liveShares: [...this.state.liveShares.filter((s) => !keys.includes(s.contactKey)), ...added] });
    for (const s of replaced) await this.sendTo(s.contactKey, { type: 'live.end', shareId: s.shareId, reason: 'stopped' }, TTL.live);
    for (const s of added) {
      await this.sendTo(s.contactKey, { type: 'live.start', shareId: s.shareId, level: s.level, expiresAt: s.expiresAt }, TTL.live);
    }
    this.preciseTracker.reset();
    this.coarseTracker.reset();
    const fix = this.freshFix();
    if (fix) await this.sendLiveUpdates({ ...fix, timestamp: now });
    this.emitLocationNeeds();
  }

  /** Stops live sharing with one contact, or with everyone. */
  async stopLive(contactKey?: ContactKey, reason: 'stopped' | 'expired' = 'stopped'): Promise<void> {
    const ending = this.state.liveShares.filter((s) => !contactKey || s.contactKey === contactKey);
    if (!ending.length) return;
    this.update({ liveShares: this.state.liveShares.filter((s) => !ending.includes(s)) });
    const ended = new Set(ending.map((s) => s.shareId));
    this.dropQueued((e) => e.message.type === 'live.update' && ended.has(e.message.shareId));
    for (const s of ending) await this.sendTo(s.contactKey, { type: 'live.end', shareId: s.shareId, reason }, TTL.live);
    this.emitLocationNeeds();
  }

  private async sendLiveUpdates(fix: LocationFix): Promise<void> {
    if (this.state.ghost || !this.state.liveShares.length) return;
    const now = this.now();
    const active = this.state.liveShares.filter((s) => isLiveShareActive(s, now));
    const precise = active.filter((s) => s.level === 'precise');
    const coarse = active.filter((s) => s.level === 'coarse');
    const point = precise.length ? this.preciseTracker.precise(fix) : undefined;
    const cell = coarse.length ? this.coarseTracker.cell(fix) : undefined;
    if (point) {
      await Promise.all(precise.map((s) => this.sendTo(s.contactKey, { type: 'live.update', shareId: s.shareId, point }, TTL.live)));
    }
    if (cell) {
      await Promise.all(coarse.map((s) => this.sendTo(s.contactKey, { type: 'live.update', shareId: s.shareId, cell }, TTL.live)));
    }
  }

  // ---- chat and quick messages -----------------------------------------------------------------

  async sendChat(to: ContactKey, text: string, opts: { urgent?: boolean } = {}): Promise<void> {
    const clean = cleanText(text, 4000);
    const id = await this.sendTo(to, { type: 'chat.text', text: clean, urgent: opts.urgent || undefined }, TTL.chat);
    if (id) this.recordSent(to, id, clean, 'text', opts.urgent);
  }

  async sendPing(to: ContactKey, kind: PingKind, text?: string, opts: { urgent?: boolean } = {}): Promise<void> {
    const clean = text?.trim() ? cleanText(text, 280) : undefined;
    const id = await this.sendTo(to, { type: 'ping', kind, text: clean, urgent: opts.urgent || undefined }, TTL.chat);
    if (id) this.recordSent(to, id, pingText(kind, clean), 'ping', opts.urgent);
  }

  // ---- check-ins and watches -------------------------------------------------------------------

  /**
   * "Gut angekommen", "Alles okay", "Bin zuhause". Also ends my running watches, those my other
   * devices started too. Without `placeName`, the place I'm at is added if everyone it goes to may
   * see that place (`checkinPlace`), unless `autoPlace` is false.
   */
  async sendCheckin(input: { to: ContactKey[]; kind: CheckinKind; text?: string; placeName?: string; autoPlace?: boolean }): Promise<void> {
    const { autoPlace = true, ...rest } = input;
    await this.checkin(rest, { addPlace: autoPlace, ends: 'all' });
  }

  /**
   * The place a check-in to these people adds by itself: the one I'm at, if each of them has a
   * grant for it. Never in ghost mode.
   */
  checkinPlace(to: ContactKey[]): string | undefined {
    const place = this.currentPlace();
    if (!place || !to.length) return undefined;
    const allowed = new Set(this.policy.placeEventRecipients(place.id, this.now()));
    return to.every((k) => allowed.has(k)) ? place.name : undefined;
  }

  /**
   * `ends`: which of my watches the check-in ends. `all` when I check in myself. An automation
   * for arriving at one of my places ends only the watches whose people all get its check-in
   * (`covered`); any other one ends `none`, since a contact may have set it off.
   */
  private async checkin(
    input: { to: ContactKey[]; kind: CheckinKind; text?: string; placeName?: string },
    opts: { addPlace: boolean; ends: 'all' | 'covered' | 'none' },
  ): Promise<void> {
    const to = [...new Set(input.to)].filter((k) => this.contact(k));
    if (!to.length) throw new RangeError('Wähle mindestens einen Kontakt.');
    const text = input.text?.trim() ? cleanText(input.text, 140) : undefined;
    const placeName = input.placeName?.trim() ? cleanText(input.placeName, 60) : opts.addPlace ? this.checkinPlace(to) : undefined;
    const id = await this.sendMany(to, { type: 'checkin', kind: input.kind, text, placeName }, TTL.chat);
    for (const k of to) this.recordSent(k, `${id.slice(0, 40)}-${k.slice(0, 8)}`, checkinText(input.kind, text, placeName), 'ping');
    if (input.kind === 'custom' || opts.ends === 'none') return;
    for (const w of [...this.state.watches]) {
      if (opts.ends === 'covered' && !w.recipients.every((k) => to.includes(k))) continue;
      await this.endWatch(w.watchId, 'ok');
    }
  }

  /**
   * "Pass auf mich auf": if I don't check in by `dueAt`, the recipients' phones raise an alarm.
   * The alarm is scheduled on their devices, so it works even if my phone is off or broken.
   */
  async startWatch(input: { to: ContactKey[]; label: string; dueAt: number; tripId?: string }): Promise<string> {
    const now = this.now();
    const to = [...new Set(input.to)].filter((k) => this.contact(k));
    if (!to.length) throw new RangeError('Wähle mindestens einen Kontakt.');
    checkWatchTime(input.dueAt, now);
    // Refused instead of dropping an old watch (whose alarm would then ring with no way to end it),
    // and capped like the recipient's phone caps it, which would otherwise ignore the new one silently.
    const active = this.state.watches;
    if (active.length >= MAX_OWN_WATCHES || to.some((k) => active.filter((w) => w.recipients.includes(k)).length >= MAX_WATCHES_PER_CONTACT)) {
      throw new RangeError('Es laufen schon zu viele „Pass auf mich auf“. Beende zuerst eines.');
    }
    const label = cleanText(input.label || 'Unterwegs', 60);
    const watchId = randomId();
    const watch: MyWatch = { watchId, recipients: to, label, dueAt: input.dueAt, startedAt: now, changedAt: now, tripId: input.tripId };
    this.update({ watches: [...active, watch] });
    await this.sendMany(to, { type: 'watch.start', watchId, label, dueAt: input.dueAt }, watchTtl(input.dueAt, now));
    this.scheduleOwnWatchAlarms(watchId);
    await this.syncWatch(watch);
    return watchId;
  }

  /** Moves the deadline of one of my watches. */
  async extendWatch(watchId: string, dueAt: number): Promise<void> {
    const w = this.state.watches.find((x) => x.watchId === watchId);
    if (!w) return;
    const now = this.now();
    checkWatchTime(dueAt, now);
    const next: MyWatch = { ...w, dueAt, changedAt: now };
    this.update({ watches: this.state.watches.map((x) => (x.watchId === watchId ? next : x)) });
    await this.sendMany(w.recipients, { type: 'watch.start', watchId, label: w.label, dueAt }, watchTtl(dueAt, now));
    this.scheduleOwnWatchAlarms(watchId);
    await this.syncWatch(next);
  }

  async endWatch(watchId: string, reason: 'ok' | 'cancelled'): Promise<void> {
    const w = this.state.watches.find((x) => x.watchId === watchId);
    if (!w) return;
    this.ended.add(`mywatch|${watchId}`);
    this.update({ watches: this.state.watches.filter((x) => x.watchId !== watchId) });
    this.emit({ type: 'alarm.cancel', id: `mywatch:${watchId}:remind` });
    this.emit({ type: 'alarm.cancel', id: `mywatch:${watchId}:due` });
    await this.sendMany(w.recipients, { type: 'watch.end', watchId, reason }, TTL.chat);
    await this.syncWatch(w, true);
  }

  /** Tells my other devices about one of my watches, so any of them can end it (see `onSyncWatch`). */
  private async syncWatch(w: MyWatch, ended?: true): Promise<void> {
    if (!this.state.devices.length) return;
    const { watchId, label, dueAt, startedAt } = w;
    const body: BodyOf<'sync.watch'> = { type: 'sync.watch', deviceId: this.state.self.deviceId, watchId, recipients: w.recipients.slice(0, 100), label, dueAt, startedAt };
    await this.sendToSelf(ended ? { ...body, ended } : body, TTL.sync);
  }

  /**
   * One of my watches, started, moved or ended on another of my devices. It runs here too: a
   * check-in on this device ends it for the people watching, also while the other device is off,
   * and this device reminds me before it is due.
   */
  private onSyncWatch(m: MessageOf<'sync.watch'>): void {
    const now = this.now();
    const existing = this.state.watches.find((w) => w.watchId === m.watchId);
    if (m.ended) {
      this.ended.add(`mywatch|${m.watchId}`);
      if (!existing) return;
      this.update({ watches: this.state.watches.filter((w) => w.watchId !== m.watchId) });
      this.emit({ type: 'alarm.cancel', id: `mywatch:${m.watchId}:remind` });
      this.emit({ type: 'alarm.cancel', id: `mywatch:${m.watchId}:due` });
      return;
    }
    // A late copy must not bring back a watch that ended, nor an older deadline.
    if (this.ended.has(`mywatch|${m.watchId}`) || now >= m.dueAt + WATCH_KEEP_MS) return;
    const sentAt = senderTime(m.sentAt, now);
    if (existing && isOlder(sentAt, existing.changedAt, now)) return;
    if (!existing && this.state.watches.length >= 2 * MAX_OWN_WATCHES) return;
    const { watchId, recipients, label, dueAt, startedAt } = m;
    const next: MyWatch = { watchId, recipients, label, dueAt, startedAt, changedAt: sentAt, ...(existing?.tripId ? { tripId: existing.tripId } : {}) };
    this.update({ watches: existing ? this.state.watches.map((w) => (w === existing ? next : w)) : [...this.state.watches, next] });
    if (dueAt > now) this.scheduleOwnWatchAlarms(watchId);
    else {
      this.emit({ type: 'alarm.cancel', id: `mywatch:${watchId}:remind` });
      this.emit({ type: 'alarm.cancel', id: `mywatch:${watchId}:due` });
    }
  }

  private scheduleOwnWatchAlarms(watchId: string): void {
    const w = this.state.watches.find((x) => x.watchId === watchId);
    if (!w) return;
    const names = w.recipients.map((k) => this.name(k)).join(', ');
    const remindAt = w.dueAt - 10 * 60_000;
    if (remindAt > this.now() + 60_000) {
      this.emit({
        type: 'alarm.schedule',
        alarm: {
          id: `mywatch:${watchId}:remind`,
          at: remindAt,
          title: 'Denk dran, dich zu melden',
          body: `Sonst bekommen ${names} um ${this.hhmm(w.dueAt)} Bescheid („${w.label}“).`,
          level: 'normal',
        },
      });
    } else {
      this.emit({ type: 'alarm.cancel', id: `mywatch:${watchId}:remind` });
    }
    this.emit({
      type: 'alarm.schedule',
      alarm: {
        id: `mywatch:${watchId}:due`,
        at: w.dueAt,
        title: '⏰ Deine Zeit ist abgelaufen',
        body: `${names} bekommen jetzt Bescheid. Melde dich mit „Alles okay“.`,
        level: 'alarm',
      },
    });
  }

  // ---- SOS -------------------------------------------------------------------------------------

  /**
   * Sends an emergency alert to my emergency contacts (or the given ones), with my exact
   * location even in ghost mode, and keeps updating the location for an hour.
   * Pressing it again while an alert runs adds recipients and renews the location updates.
   */
  async startSos(input: { text?: string; recipients?: ContactKey[] } = {}): Promise<void> {
    const now = this.now();
    this.noteClock(now);
    const chosen = input.recipients?.length ? input.recipients : this.emergencyContacts().map((c) => c.key);
    const existing = this.state.sos;
    const all = [...new Set([...(existing?.recipients ?? []), ...chosen])].filter((k) => this.contact(k)).slice(0, 21);
    if (!all.length) throw new RangeError('Lege zuerst Notfallkontakte fest.');
    const text = (input.text?.trim() || existing?.text || this.state.sosMessage)?.slice(0, 200) || undefined;
    const sosId = existing?.sosId ?? randomId();
    this.update({
      sos: {
        sosId,
        startedAt: existing?.startedAt ?? now,
        recipients: all,
        text,
        locationUntil: now + SOS_LOCATION_MS,
        pointSentAt: existing?.pointSentAt,
        acks: existing?.acks ?? [],
      },
    });
    this.sosTracker.reset();
    const fix = this.freshFix();
    if (fix) this.sosTracker.precise(fix);
    const point = fix ? toPoint(fix) : undefined;
    if (point) this.update({ sos: { ...this.state.sos!, pointSentAt: now } });
    await Promise.all(
      all.map((to) =>
        this.sendTo(
          to,
          {
            type: 'sos.start',
            sosId,
            text,
            point,
            others: all
              .filter((k) => k !== to)
              .map((k) => ({ key: k, name: this.contact(k)!.name }))
              .slice(0, 20),
          },
          TTL.sos,
        ),
      ),
    );
    this.emitLocationNeeds();
  }

  async endSos(reason: 'safe' | 'cancelled'): Promise<void> {
    const sos = this.state.sos;
    if (!sos) return;
    this.update({ sos: undefined });
    await this.sendMany(sos.recipients, { type: 'sos.end', sosId: sos.sosId, reason }, TTL.sos);
    this.emitLocationNeeds();
  }

  /** "Ich kümmere mich": tells the person in need and the other helpers. */
  async ackSos(owner: ContactKey, text?: string): Promise<void> {
    const sos = this.statuses.get(owner)?.sos;
    if (!sos || sos.endedAt) return;
    const clean = text?.trim() ? cleanText(text, 140) : undefined;
    const helpers = sos.others.map((o) => o.key).filter((k) => this.contact(k));
    await this.sendMany([owner, ...helpers], { type: 'sos.ack', sosId: sos.sosId, owner, text: clean }, TTL.sos);
    const me = { key: this.state.self.key, name: this.state.self.name, at: this.now(), text: clean };
    this.setStatus(owner, { sos: { ...sos, acks: [...sos.acks.filter((a) => a.key !== me.key), me] } });
  }

  emergencyContacts(): Contact[] {
    return this.state.contacts.filter((c) => c.emergency);
  }

  /** Text and phone numbers for the SMS fallback of my running SOS. */
  sosFallback(): { text: string; phones: string[] } | undefined {
    const sos = this.state.sos;
    if (!sos) return undefined;
    const phones = sos.recipients.map((k) => this.contact(k)?.phone).filter((p): p is string => !!p);
    return { text: sosFallbackText(this.state.self.name, sos.text, this.freshFix(30 * 60_000)), phones };
  }

  private async sendSosUpdate(fix: LocationFix): Promise<void> {
    const sos = this.state.sos;
    if (!sos || !isSosLocationActive(sos, this.now())) return;
    const point = this.sosTracker.precise(fix);
    if (!point) return;
    this.update({ sos: { ...sos, pointSentAt: this.now() } });
    await this.sendMany(sos.recipients, { type: 'sos.update', sosId: sos.sosId, point }, TTL.sos);
  }

  // ---- "where are you?" ------------------------------------------------------------------------

  async askWhere(to: ContactKey): Promise<void> {
    if (!this.contact(to)) return;
    const now = this.now();
    if (!this.askLimiter.allow(to, now)) throw new Error('Du hast gerade schon oft gefragt. Warte ein bisschen.');
    const requestId = randomId();
    this.update({ whereAsked: [...this.state.whereAsked.filter((w) => now - w.at < DAY).slice(-49), { from: to, requestId, at: now }] });
    await this.sendTo(to, { type: 'where.request', requestId }, TTL.place);
    this.recordSent(to, requestId, '📍 Wo bist du?', 'ping');
  }

  /**
   * Answers a "where are you?". Each answer is my explicit choice for this one question:
   * a text, the name of the place I'm at, my ETA, a 2 km area or my exact location.
   */
  async answerWhere(
    from: ContactKey,
    requestId: string,
    answer: { kind: 'declined' | 'text' | 'place' | 'eta' | 'coarse' | 'precise'; text?: string },
  ): Promise<void> {
    const req = this.state.whereInbox.find((w) => w.from === from && w.requestId === requestId);
    if (!req) return;
    const body: BodyOf<'where.reply'> = { type: 'where.reply', requestId, answer: answer.kind };
    switch (answer.kind) {
      case 'text':
        body.text = cleanText(answer.text ?? '', 140);
        break;
      case 'place': {
        const place = this.currentPlace();
        if (!place) throw new Error('Du bist gerade an keinem deiner Orte.');
        body.placeName = place.name;
        break;
      }
      case 'eta': {
        const trip = this.activeTrip;
        if (!trip) throw new Error('Du bist gerade nicht unterwegs.');
        body.placeName = trip.destinationName;
        if (this.activeTripEta !== undefined) body.etaMinutes = this.activeTripEta;
        break;
      }
      case 'coarse':
      case 'precise': {
        const fix = this.freshFix(10 * 60_000);
        if (!fix) throw new Error('Dein Standort ist gerade nicht bekannt.');
        if (answer.kind === 'precise') body.point = toPoint(fix);
        else {
          const c = snapToGrid(fix);
          body.cell = { lat: c.lat, lon: c.lon, cellM: c.cellM };
        }
        break;
      }
      case 'declined':
        break;
    }
    if (answer.kind !== 'text' && answer.text?.trim()) body.text = cleanText(answer.text, 140);
    this.update({ whereInbox: this.state.whereInbox.filter((w) => w !== req) });
    const id = await this.sendTo(from, body, TTL.place);
    if (id) this.recordSent(from, id, whereText(body), 'ping');
  }

  // ---- groups ----------------------------------------------------------------------------------

  async createGroup(name: string, memberKeys: ContactKey[]): Promise<Group> {
    if (this.liveGroups().length >= MAX_GROUPS) throw new RangeError('Du hast schon sehr viele Gruppen.');
    const group: Group = {
      id: randomId(),
      name: cleanText(name, 40),
      owner: this.state.self.key,
      members: this.rosterFor(memberKeys),
      version: 1,
      updatedAt: this.now(),
    };
    this.update({ groups: capGroups([...this.state.groups, group], MAX_GROUPS) });
    this.markSync();
    await this.broadcastRoster(group, []);
    return group;
  }

  /** Owner only: rename the group or change who is in it. */
  async editGroup(groupId: string, patch: { name?: string; members?: ContactKey[] }): Promise<void> {
    const g = this.group(groupId);
    if (!g || g.owner !== this.state.self.key) throw new Error('Nur wer die Gruppe erstellt hat, kann sie ändern.');
    const members = patch.members ? this.rosterFor(patch.members, g.members) : g.members;
    const next: Group = {
      ...g,
      name: patch.name !== undefined ? cleanText(patch.name, 40) : g.name,
      members,
      version: g.version + 1,
      updatedAt: this.now(),
    };
    this.update({ groups: this.state.groups.map((x) => (x.id === groupId ? next : x)) });
    this.markSync();
    const removed = g.members.filter((m) => !members.some((x) => x.key === m.key)).map((m) => m.key);
    await this.broadcastRoster(next, removed, g.name);
  }

  /** Leaves a group. If I own it, the group is dissolved for everyone. */
  async leaveGroup(groupId: string): Promise<void> {
    const g = this.group(groupId);
    if (!g) return;
    const others = g.members.map((m) => m.key).filter((k) => k !== this.state.self.key);
    this.update({
      groups: this.state.groups.filter((x) => x.id !== groupId),
      leftGroups: [...this.state.leftGroups.filter((x) => x.id !== groupId), { id: groupId, at: this.now() }].slice(-200),
    });
    this.markSync();
    if (g.owner === this.state.self.key) {
      await this.sendMany(others, { ...rosterBody(g), version: g.version + 1, dissolved: true }, TTL.chat, true);
    } else {
      await this.sendMany(others, { type: 'group.leave', groupId }, TTL.chat, true);
    }
  }

  async sendGroupText(groupId: string, text: string, opts: { urgent?: boolean } = {}): Promise<void> {
    const g = this.group(groupId);
    if (!g || g.dissolved) throw new Error('Diese Gruppe gibt es nicht mehr.');
    const clean = cleanText(text, 4000);
    const others = g.members.map((m) => m.key).filter((k) => k !== this.state.self.key);
    const id = await this.sendMany(others, { type: 'group.text', groupId, text: clean, urgent: opts.urgent || undefined }, TTL.chat, true);
    this.recordSent(`g:${groupId}`, id, clean, 'text', opts.urgent);
  }

  private rosterFor(keys: ContactKey[], previous: GroupMember[] = []): GroupMember[] {
    const self: GroupMember = { key: this.state.self.key, name: this.state.self.name, relays: this.state.self.relays };
    const members = [...new Set(keys)]
      .filter((k) => k !== this.state.self.key)
      .map((k): GroupMember | undefined => {
        const c = this.contact(k);
        return c ? { key: c.key, name: c.name, relays: c.relays } : previous.find((m) => m.key === k);
      })
      .filter((m): m is GroupMember => !!m);
    if (!members.length) throw new RangeError('Wähle mindestens einen Kontakt.');
    if (members.length + 1 > MAX_GROUP_MEMBERS) throw new RangeError(`Eine Gruppe hat höchstens ${MAX_GROUP_MEMBERS} Personen.`);
    return [self, ...members];
  }

  /**
   * The roster goes to everyone in the group. People just taken off learn only that they are out:
   * they get the name they knew and the owner alone, not who else is in it or was just added.
   */
  private async broadcastRoster(g: Group, removed: ContactKey[], previousName = g.name): Promise<void> {
    const to = g.members.map((m) => m.key).filter((k) => k !== this.state.self.key);
    const out = rosterBody({ ...g, name: previousName, members: g.members.filter((m) => m.key === g.owner) });
    await Promise.all([this.sendMany(to, rosterBody(g), TTL.chat, true), removed.length ? this.sendMany(removed, out, TTL.chat, true) : undefined]);
  }

  /** Groups I am in, without the hidden copies of groups I was taken off. */
  private liveGroups(): Group[] {
    return this.state.groups.filter((g) => !g.dissolved);
  }

  // ---- my other devices -----------------------------------------------------------------------

  private get deviceKind(): DeviceKind {
    return this.options.deviceKind ?? 'phone';
  }

  /**
   * Whether automations set off by contacts may act here beyond notifications: send messages,
   * pings and check-ins, start a trip, set my status or a shared quiet mode. Every device of my
   * account gets the same messages and has the same rules, so only one kind of device does this,
   * or contacts would get everything once per device. A phone always does; a computer only when
   * none of my other devices is a phone or might be one (not told yet, e.g. an older version).
   * Notifications show on every device; rules on my own arrival run where my location is.
   */
  get runsAutomationActions(): boolean {
    if (this.deviceKind === 'phone') return true;
    const self = this.state.self.deviceId;
    return this.state.devices.every((d) => d.deviceId === self || d.kind === 'computer');
  }

  /**
   * Where linking a new device stands (see `sync/link.ts`): `waiting` for the new device to
   * answer, then `compare` with the 6 digits. Undefined when nothing runs or the code expired.
   */
  get linkStatus(): LinkStatus | undefined {
    const p = this.pendingLink;
    if (!p || p.expiresAt <= this.now()) return undefined;
    return p.code === undefined ? { phase: 'waiting', expiresAt: p.expiresAt } : { phase: 'compare', code: p.code, expiresAt: p.expiresAt };
  }

  /**
   * Starts linking the new device that shows this device code: picks my random share and
   * sends it to the code's one-time key. The digits appear in `linkStatus` once the new device
   * answered. Replaces a link already in progress, unless it is the same code again: then my
   * share stays (a new one would no longer match the new device's digits) and the hello is only
   * repeated while waiting. Throws (in German) for bad codes. A failed send keeps the session:
   * the hello may have arrived anyway, and scanning the code again repeats the same share.
   */
  async startLink(text: string): Promise<void> {
    const d = decodeLinkInvite(text, this.now());
    if (!d.ok) throw new Error(d.error);
    if (d.invite.tempKey === this.state.self.key) throw new Error('Dieser Code passt nicht. Lass auf dem neuen Gerät einen neuen anzeigen.');
    const current = this.pendingLink;
    const same =
      current !== undefined &&
      current.expiresAt > this.now() &&
      current.invite.tempKey === d.invite.tempKey &&
      current.invite.nonce === d.invite.nonce &&
      current.invite.commit === d.invite.commit;
    if (same && current.code !== undefined) return;
    let session: PendingLink;
    if (same) {
      session = current;
    } else {
      this.clearLink(false);
      const startedAt = this.now();
      session = { invite: d.invite, rE: randomLinkSecret(), startedAt, expiresAt: Math.min(d.invite.expiresAt, startedAt + LINK_TTL_MS) };
      // Set before sending, so the answer is accepted however fast it comes.
      this.pendingLink = session;
      this.emitLink();
    }
    const hello: BodyOf<'link.hello'> = {
      type: 'link.hello',
      nonce: session.invite.nonce,
      rE: base64urlEncode(session.rE),
      relays: this.state.self.relays.filter((r) => RelayUrl.safeParse(r).success).slice(0, 8),
    };
    try {
      await this.transport.send(session.invite.tempKey, composeMessage(hello, this.now()), { ttlSeconds: TTL.link, relays: session.invite.relays });
    } catch {
      // The relay may have kept it although no OK came back: wiping my share now would make
      // the digits differ once the new device answers. It goes with cancel, expiry or another code.
      throw new Error('Keine Verbindung. Prüfe dein Internet und versuch es nochmal.');
    }
  }

  /**
   * The person saw the same digits on both devices: sends my account to the new device. The
   * identity key travels end-to-end encrypted to the new device's one-time key; only that
   * device can read it. Only possible while `linkStatus` is `compare`.
   */
  async confirmLink(secretKeyHex: string): Promise<void> {
    const p = this.pendingLink;
    if (!p || p.expiresAt <= this.now()) throw new Error('Die Zeit ist abgelaufen. Lass auf dem neuen Gerät einen neuen Code anzeigen.');
    if (p.code === undefined) throw new Error('Vergleiche zuerst die Zahlen auf beiden Geräten.');
    if (p.sending) throw new Error('Dein Konto wird schon gesendet.');
    if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) throw new Error('Ungültiger Schlüssel.');
    if (!p.chunks) {
      const { self } = this.state;
      const payload = {
        format: 'heyda.link',
        v: 2,
        nonce: p.invite.nonce,
        secretKey: secretKeyHex,
        relays: self.relays.filter((r) => RelayUrl.safeParse(r).success).slice(0, 8),
        deviceId: self.deviceId,
        deviceName: self.deviceName,
        deviceKind: this.deviceKind,
        devices: this.state.devices,
        doc: buildSyncDoc(this.state),
      };
      // The new device keeps at most two unfinished transfers; a new id per try would run out.
      p.chunks = chunkPayload(randomId(), 'link', payload);
    }
    p.sending = true;
    try {
      for (const chunk of p.chunks) {
        await this.transport.send(p.invite.tempKey, composeMessage(chunk, this.now()), { ttlSeconds: TTL.link, relays: p.invite.relays });
      }
    } catch {
      // Stays in `compare`, so the person can try again.
      p.sending = false;
      throw new Error('Senden hat nicht geklappt. Prüfe dein Internet und versuch es nochmal.');
    }
    if (this.pendingLink === p) this.clearLink();
  }

  /** Stops a device link in progress and forgets its secret. */
  cancelLink(): void {
    this.clearLink();
  }

  private clearLink(emit = true): void {
    const p = this.pendingLink;
    if (!p) return;
    p.rE.fill(0);
    delete p.chunks;
    this.pendingLink = undefined;
    if (emit) this.emitLink();
  }

  private emitLink(): void {
    this.emit({ type: 'link', status: this.linkStatus });
  }

  /** Whether a link.reveal is the one answer my pending device link waits for. */
  private awaitsReveal(from: ContactKey, m: MessageOf<'link.reveal'>): boolean {
    const p = this.pendingLink;
    return !!p && p.code === undefined && p.expiresAt > this.now() && from === p.invite.tempKey && m.nonce === p.invite.nonce;
  }

  private onLinkReveal(from: ContactKey, m: MessageOf<'link.reveal'>): void {
    const p = this.pendingLink;
    if (!p || !this.awaitsReveal(from, m)) return;
    const rN = base64urlDecode(m.rN);
    if (rN.length !== LINK_SECRET_BYTES || linkCommitment(rN) !== p.invite.commit) {
      // The device that made the code did not keep its word: never send this one anything.
      rN.fill(0);
      this.clearLink();
      return;
    }
    p.code = linkCode({ tempKey: p.invite.tempKey, nonce: p.invite.nonce, accountKey: this.state.self.key, rE: p.rE, rN });
    rN.fill(0);
    p.rE.fill(0);
    this.emitLink();
  }

  /** Called once on a freshly linked device: tells my other devices it exists. */
  async announceLinked(): Promise<void> {
    await this.sendToSelf({ type: 'link.done', deviceId: this.state.self.deviceId, deviceName: this.state.self.deviceName }, TTL.sync);
  }

  /** Forgets a device in the list. Its copy of the account keeps working until it is reset there. */
  removeDevice(deviceId: string): void {
    this.update({ devices: this.state.devices.filter((d) => d.deviceId !== deviceId) });
  }

  /** Sends my settings to my other devices now, if something changed. */
  async flushSync(): Promise<void> {
    if (!this.syncDue) return;
    this.syncDue = false;
    if (!this.state.devices.length) return;
    const payload = {
      format: 'heyda.sync',
      v: 1,
      deviceId: this.state.self.deviceId,
      deviceName: this.state.self.deviceName,
      // Older versions ignore it; see `runsAutomationActions`.
      deviceKind: this.deviceKind,
      doc: buildSyncDoc(this.state),
    };
    for (const chunk of chunkPayload(randomId(), 'sync', payload)) await this.sendToSelf(chunk, TTL.sync);
  }

  // ---- housekeeping ----------------------------------------------------------------------------

  /**
   * Call regularly (every 15–60 s while running, and when the app wakes up): ends expired
   * shares, raises overdue watch alarms, updates quiet-mode presence and retries the outbox.
   */
  async tick(): Promise<void> {
    const now = this.now();
    this.noteClock(now);
    if (this.trip && !this.trip.isEnded) {
      const end = this.trip.expire(now);
      if (end.length) {
        for (const body of end) await this.broadcastTrip(body);
        this.afterTripEnded();
      }
    }
    for (const s of this.state.liveShares.filter((x) => !isLiveShareActive(x, now))) {
      await this.stopLive(s.contactKey, 'expired');
    }
    if (this.state.status && now >= this.state.status.expiresAt) {
      this.update({ status: undefined }, ['status']);
    }
    const manualUntil = this.state.prefs.dnd.manual?.until;
    if (manualUntil !== undefined && now >= manualUntil) {
      const dnd = { ...this.state.prefs.dnd };
      delete dnd.manual;
      this.update({ prefs: { ...this.state.prefs, dnd } }, ['prefs']);
    }
    this.lastDndActive = this.dndActive();
    await this.broadcastPresence();
    const watches = this.state.watches.filter((w) => now < w.dueAt + 12 * HOUR);
    if (watches.length !== this.state.watches.length) this.update({ watches });
    this.ringMissed(now);
    this.pruneLists(now);
    if (this.pendingLink && this.pendingLink.expiresAt <= now) this.clearLink();
    this.emitLocationNeeds();
    await this.flushOutbox();
    await this.flushSync();
  }

  /**
   * Tries to send everything that failed earlier (e.g. while offline). SOS, watch and where-answers
   * go first. A failure holds back only the rest for that person (their relay may be gone for good),
   * and only failures to several people in a row mean I am offline, which ends the round.
   */
  async flushOutbox(force = false): Promise<void> {
    if (this.flushingOutbox || !this.state.outbox.length) return;
    this.flushingOutbox = true;
    try {
      const before = new Set(this.state.outbox);
      const now = this.now();
      const next = new Map<OutboxEntry, OutboxEntry>();
      const failed = new Set<ContactKey>();
      let failuresInARow = 0;
      const maxWaitMs = 10 * 60_000;
      // Stable, so messages to one person keep their order within each rank.
      const rank = (e: OutboxEntry) => (PRIORITY_TYPES.has(e.message.type) ? 0 : 2) + (this.unreachable.has(e.to) ? 1 : 0);
      for (const e of [...before].sort((a, b) => rank(a) - rank(b))) {
        // Only the time that is left, so a late retry does not keep the message on relays for longer
        // (and never more than it was given, also after the clock was set back).
        const ttlSeconds = Math.min(e.ttlSeconds, Math.ceil((e.firstAt + e.ttlSeconds * 1000 - now) / 1000));
        if (ttlSeconds <= 0) continue;
        // They stopped being a contact after it was queued: where I am never goes to them.
        if (CARRIES_LOCATION.has(e.message.type) && !this.contact(e.to)) continue;
        // A retry further ahead than the longest wait means the clock was set back: it is due now.
        const waiting = e.nextAt !== undefined && e.nextAt > now && e.nextAt - now <= maxWaitMs;
        if (failuresInARow >= OFFLINE_AFTER_FAILURES || failed.has(e.to) || (!force && waiting)) {
          next.set(e, e);
          continue;
        }
        try {
          await this.transport.send(e.to, e.message, { ttlSeconds, ...(e.relays?.length ? { relays: e.relays } : {}) });
          failuresInARow = 0;
          this.unreachable.delete(e.to);
        } catch {
          // A message the wire format rejects fails forever; keeping it would hold up everything behind it.
          if (!isSendable(e.message)) continue;
          failed.add(e.to);
          this.unreachable.add(e.to);
          failuresInARow++;
          const attempts = e.attempts + 1;
          next.set(e, { ...e, attempts, nextAt: now + Math.min(maxWaitMs, 15_000 * 2 ** Math.min(attempts, 6)) });
        }
      }
      // Entries queued while this loop was sending stay too; entries dropped meanwhile stay dropped.
      const current = new Set(this.state.outbox);
      const added = this.state.outbox.filter((e) => !before.has(e));
      const kept = [...before].flatMap((e) => (current.has(e) && next.has(e) ? [next.get(e)!] : []));
      const outbox = [...kept, ...added].slice(-MAX_OUTBOX);
      for (const k of [...this.unreachable]) if (!outbox.some((e) => e.to === k)) this.unreachable.delete(k);
      this.update({ outbox });
    } finally {
      this.flushingOutbox = false;
    }
  }

  // ---- incoming --------------------------------------------------------------------------------

  /**
   * Whether this device acts on a message from `from` at all. Only contacts can reach it;
   * group members who are not my contacts may write in a group whose owner is me or still a
   * contact of mine (the owner vouches for them), and leave a group I own. An owner I removed
   * as a contact can only let me go. A stranger may answer a QR code I showed.
   * A transport can call this to keep strangers' messages out of its list of processed ones.
   */
  acceptsMessage(from: ContactKey, message: AppMessage): boolean {
    if (from === this.state.self.key || this.contact(from)) return true;
    switch (message.type) {
      case 'hello':
        return message.inviteNonce !== undefined && this.state.openInvites.some((i) => i.nonce === message.inviteNonce);
      case 'group.text': {
        const owner = this.group(message.groupId)?.owner;
        return this.isMember(message.groupId, from) && owner !== undefined && (owner === this.state.self.key || !!this.contact(owner));
      }
      case 'group.leave':
        // Only the owner acts on it.
        return this.isMember(message.groupId, from) && this.group(message.groupId)?.owner === this.state.self.key;
      case 'group.update':
        // From an owner who is no longer my contact: only taking me off, or dissolving the group.
        return (
          this.group(message.groupId)?.owner === from &&
          (message.dissolved === true || !message.members.some((m) => m.key === this.state.self.key))
        );
      case 'link.reveal':
        // The one-time key of a device I am linking, answering my hello once, for that code only.
        return this.awaitsReveal(from, message);
      default:
        return false;
    }
  }

  private async handleIncoming({ from, message }: IncomingMessage): Promise<void> {
    // Before the duplicate filter, so a stranger's flood cannot push contacts' ids out of it
    // and get an old message of theirs, replayed from a relay, handled a second time.
    if (!this.acceptsMessage(from, message)) return;
    if (!this.seen.add(`${from}|${message.id}`)) return;

    // Whoever sent it (stranger, contact or my own key), a reveal only ever moves my pending link.
    if (message.type === 'link.reveal') {
      this.onLinkReveal(from, message);
      return;
    }
    const at = this.now();
    // From before this device got the account: it fills in chats and statuses, but rings nothing.
    this.replaying = this.isHistory(message.sentAt, at);
    let handled: Promise<void> | void;
    try {
      handled = this.dispatch(from, message, at);
    } finally {
      this.replaying = false;
    }
    await handled;
  }

  /**
   * Whether a message was sent before this device got the account (see `NodeState.historyBefore`).
   * Never while my clock reads earlier than that moment: it was set back since, and every message
   * would look old.
   */
  private isHistory(sentAt: number, at: number): boolean {
    const before = this.state.historyBefore;
    return before !== undefined && before <= at + CLOCK_TOLERANCE_MS && senderTime(sentAt, at) < before - HISTORY_MARGIN_MS;
  }

  private dispatch(from: ContactKey, message: AppMessage, at: number): Promise<void> | void {
    if (from === this.state.self.key) {
      this.handleOwn(message);
      return;
    }
    if (message.type === 'hello') {
      this.handleHello(from, message);
      return;
    }

    switch (message.type) {
      case 'presence':
        return this.onPresence(from, message, at);
      case 'session.start':
        return this.onTripStart(from, message, at);
      case 'session.update':
        return this.onTripUpdate(from, message, at);
      case 'session.end':
        return this.onTripEnd(from, message, at);
      case 'place.event':
        return this.onPlaceEvent(from, message, at);
      case 'live.start':
      case 'live.update':
      case 'live.end':
        return this.onLive(from, message, at);
      case 'checkin':
        return this.onCheckin(from, message, at);
      case 'watch.start':
        return this.onWatchStart(from, message, at);
      case 'watch.end':
        return this.onWatchEnd(from, message);
      case 'sos.start':
      case 'sos.update':
      case 'sos.end':
        return this.onSos(from, message, at);
      case 'sos.ack':
        return this.onSosAck(from, message, at);
      case 'where.request':
        return this.onWhereRequest(from, message, at);
      case 'where.reply':
        return this.onWhereReply(from, message, at);
      case 'chat.text': {
        const urgent = this.isUrgent(from, message.urgent, at);
        this.emit({ type: 'chat', thread: from, entry: { id: message.id, from, text: message.text, at, kind: 'text', urgent: urgent || undefined } });
        this.alert({ category: 'chat', title: this.name(from), body: message.text, from, thread: from, urgent });
        return this.runAutomations({ type: 'contact.message', contact: from, text: message.text, at });
      }
      case 'ping': {
        const urgent = this.isUrgent(from, message.urgent, at);
        const text = pingText(message.kind, message.text);
        this.emit({ type: 'chat', thread: from, entry: { id: message.id, from, text, at, kind: 'ping', urgent: urgent || undefined } });
        this.alert({ category: 'ping', title: this.name(from), body: text, from, thread: from, urgent });
        return this.runAutomations({ type: 'contact.ping', contact: from, kind: message.kind, text: message.text, at });
      }
      case 'group.update':
        return this.onGroupUpdate(from, message);
      case 'group.text':
        return this.onGroupText(from, message, at);
      case 'group.leave':
        return this.onGroupLeave(from, message);
      default:
        // sync.sent, link.done and xfer.chunk only count from my own devices; link.hello goes to a
        // new device's one-time key, never to an account.
        return;
    }
  }

  /** "Urgent" breaks through quiet mode, a few times an hour per sender; old messages use none of that. */
  private isUrgent(from: ContactKey, urgent: boolean | undefined, at: number): boolean {
    return urgent === true && !this.replaying && this.urgentLimiter.allow(from, at);
  }

  private handleHello(from: ContactKey, message: MessageOf<'hello'>): void {
    const existing = this.contact(from);
    if (existing) {
      const changed = existing.name !== message.name || JSON.stringify(existing.relays) !== JSON.stringify(message.relays);
      if (changed && this.helloLimiter.allow(from, this.now())) this.editContact(from, { name: message.name, relays: message.relays });
      return;
    }
    // A stranger may only become a contact by answering a QR code this device showed.
    const invite = message.inviteNonce ? this.state.openInvites.find((i) => i.nonce === message.inviteNonce) : undefined;
    if (!invite) return;
    this.update({ openInvites: this.state.openInvites.filter((i) => i !== invite) });
    if (invite.expiresAt <= this.now()) return;
    try {
      this.addContact({ key: from, name: message.name, relays: message.relays });
    } catch {
      // Contact list full.
    }
  }

  private handleOwn(message: AppMessage): void {
    const { self } = this.state;
    switch (message.type) {
      case 'sync.sent':
        if (message.deviceId === self.deviceId) return;
        this.emit({
          type: 'chat',
          thread: message.thread,
          entry: { id: message.msgId, from: 'me', text: message.text, at: Math.min(message.at, this.now()), kind: message.kind },
        });
        return;
      case 'sync.watch':
        if (message.deviceId !== self.deviceId) this.onSyncWatch(message);
        return;
      case 'link.done': {
        if (message.deviceId === self.deviceId) return;
        const known = this.state.devices.some((d) => d.deviceId === message.deviceId);
        this.upsertDevice(message.deviceId, message.deviceName);
        if (!known) {
          this.alert({ category: 'device', title: 'Neues Gerät verbunden', body: `„${message.deviceName}“ nutzt jetzt dein Konto.` });
          this.markSync();
        }
        return;
      }
      case 'xfer.chunk': {
        if (message.purpose !== 'sync') return;
        const payload = this.reassembler.add(self.key, message, this.now());
        if (payload !== undefined) this.onSyncPayload(payload);
        return;
      }
      default:
        return;
    }
  }

  private onSyncPayload(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const p = raw as { format?: unknown; v?: unknown; deviceId?: unknown; deviceName?: unknown; deviceKind?: unknown; doc?: unknown };
    if (p.format !== 'heyda.sync' || p.v !== 1 || typeof p.deviceId !== 'string') return;
    if (p.deviceId === this.state.self.deviceId || !/^[A-Za-z0-9_-]{8,32}$/.test(p.deviceId)) return;
    const doc = parseSyncDoc(p.doc);
    if (!doc) return;
    const deviceName = typeof p.deviceName === 'string' ? p.deviceName.trim().slice(0, 40) : '';
    const kind = p.deviceKind === 'phone' || p.deviceKind === 'computer' ? p.deviceKind : undefined;
    // First heard what that device is: tell it what this one is (once per device, so no loop).
    if (this.upsertDevice(p.deviceId, deviceName || 'Gerät', kind)) this.markSync();
    const now = this.now();
    const patch = mergeSyncDoc(this.state, doc, now);
    if (patch.places) this.geofence.setPlaces(patch.places);
    if (patch.contacts) {
      // Removed on another device: what this device runs with them ends here too, before they go.
      const kept = new Set(patch.contacts.map((c) => c.key));
      const known = [...this.state.contacts.map((c) => c.key), ...this.statuses.keys(), ...this.state.liveShares.map((l) => l.contactKey)];
      const gone = new Set(known.filter((k) => !kept.has(k)));
      for (const key of gone) void this.endEverythingWith(key);
    }
    if (Object.keys(patch).length) this.update(patch);
    // Answer only if the other device would change something by taking my version. Comparing
    // the lists directly made two devices whose lists merely differed in order (or tied) send
    // each other their whole settings forever.
    const theirs: NodeState = {
      ...this.state,
      self: { ...this.state.self, name: doc.profileName },
      contacts: doc.contacts,
      removedContacts: doc.removedContacts,
      groups: doc.groups,
      leftGroups: doc.leftGroups ?? [],
      places: doc.places,
      grants: doc.grants,
      rules: doc.rules,
      prefs: doc.prefs,
      sosMessage: doc.sosMessage,
      status: doc.status,
      syncRev: doc.rev,
    };
    if (Object.keys(mergeSyncDoc(theirs, buildSyncDoc(this.state), now)).length) this.markSync();
  }

  /** Adds or updates one of my devices. True when this told me for the first time what kind of device it is. */
  private upsertDevice(deviceId: string, name: string, kind?: DeviceKind): boolean {
    const existing = this.state.devices.find((d) => d.deviceId === deviceId);
    const learned = kind !== undefined && existing?.kind !== kind;
    if (existing && existing.name === name && !learned) return false;
    const device: LinkedDevice = { deviceId, name, linkedAt: existing?.linkedAt ?? this.now() };
    const known = kind ?? existing?.kind;
    if (known) device.kind = known;
    this.update({ devices: [...this.state.devices.filter((d) => d.deviceId !== deviceId), device].slice(-20) });
    return learned;
  }

  private onPresence(from: ContactKey, m: MessageOf<'presence'>, at: number): void {
    const prev = this.statuses.get(from)?.presence;
    const sentAt = senderTime(m.sentAt, at);
    if (isOlder(sentAt, prev?.sentAt, at)) return;
    const presence: NonNullable<ContactStatus['presence']> = { updatedAt: at, sentAt };
    if (m.status && m.status.expiresAt > at) presence.status = m.status;
    if (m.dnd && (m.dnd.until === undefined || m.dnd.until > at)) presence.dnd = m.dnd;
    this.setStatus(from, { presence });
    const s = presence.status;
    if (s && JSON.stringify(s) !== JSON.stringify(prev?.status)) {
      this.alert({ category: 'status', title: this.name(from), body: [s.emoji, s.text].filter(Boolean).join(' '), from, thread: from });
    }
  }

  private async onTripStart(from: ContactKey, m: MessageOf<'session.start'>, at: number): Promise<void> {
    if (this.ended.has(`trip|${from}|${m.sessionId}`)) return;
    const prev = this.statuses.get(from)?.trip;
    const same = prev?.sessionId === m.sessionId;
    // Relays may reorder: an older trip caught up late must not replace the one running now.
    if (prev && !same && isOlder(senderTime(m.sentAt, at), prev.lastSentAt, at)) return;
    this.setStatus(from, {
      trip: {
        ...(same ? prev : {}),
        sessionId: m.sessionId,
        destinationName: m.destinationName,
        level: m.level,
        expiresAt: Math.min(m.expiresAt, at + DAY),
        updatedAt: at,
        lastSentAt: same ? prev.lastSentAt : senderTime(m.sentAt, at),
      },
    });
    if (same) return;
    this.alert({ category: 'trip', title: `${this.name(from)} ist unterwegs`, body: `nach ${m.destinationName}`, from, thread: from });
    await this.runAutomations({ type: 'contact.trip_start', contact: from, sessionId: m.sessionId, destinationName: m.destinationName, at });
  }

  private async onTripUpdate(from: ContactKey, m: MessageOf<'session.update'>, at: number): Promise<void> {
    if (this.ended.has(`trip|${from}|${m.sessionId}`)) return;
    const prev = this.statuses.get(from)?.trip;
    const sentAt = senderTime(m.sentAt, at);
    if (prev && prev.sessionId === m.sessionId && isOlder(sentAt, prev.lastSentAt, at)) return; // relays may reorder
    const base =
      prev?.sessionId === m.sessionId
        ? prev
        : { sessionId: m.sessionId, destinationName: '…', level: 'eta' as const, expiresAt: at + HOUR };
    // Only show what the trip's level allows, even if a buggy sender includes more.
    const cell = base.level !== 'eta' ? m.cell : undefined;
    const point = base.level === 'precise' ? m.point : undefined;
    const trip = {
      ...base,
      ...(m.etaMinutes !== undefined ? { etaMinutes: m.etaMinutes } : {}),
      ...(cell ? { cell } : {}),
      ...(point ? { point } : {}),
      updatedAt: at,
      lastSentAt: sentAt,
    };
    this.setStatus(from, { trip });
    if (m.etaMinutes !== undefined) {
      await this.runAutomations({
        type: 'contact.eta',
        contact: from,
        sessionId: m.sessionId,
        etaMinutes: m.etaMinutes,
        destinationName: trip.destinationName,
        at,
      });
    }
  }

  private async onTripEnd(from: ContactKey, m: MessageOf<'session.end'>, at: number): Promise<void> {
    if (!this.ended.add(`trip|${from}|${m.sessionId}`)) return;
    const current = this.statuses.get(from)?.trip;
    const mine = current?.sessionId === m.sessionId;
    if (mine) this.setStatus(from, { trip: undefined });
    if (m.reason === 'arrived') {
      this.alert({
        category: 'arrival',
        title: `${this.name(from)} ist angekommen`,
        body: mine ? `📍 ${current.destinationName}` : '📍 am Ziel',
        from,
        thread: from,
      });
    }
    await this.runAutomations({ type: 'contact.trip_end', contact: from, sessionId: m.sessionId, reason: m.reason, at });
  }

  private async onPlaceEvent(from: ContactKey, m: MessageOf<'place.event'>, at: number): Promise<void> {
    const sentAt = senderTime(m.sentAt, at);
    // An older arrive or leave caught up late is out of date: no new state, alert or automation.
    if (isOlder(sentAt, this.statuses.get(from)?.lastPlace?.sentAt, at)) return;
    this.setStatus(from, { lastPlace: { kind: m.kind, placeName: m.placeName, at, sentAt } });
    const arrive = m.kind === 'arrive';
    this.alert({
      category: 'arrival',
      title: arrive ? `${this.name(from)} ist angekommen` : `${this.name(from)} ist losgegangen`,
      body: arrive ? `📍 ${m.placeName}` : `hat ${m.placeName} verlassen`,
      from,
      thread: from,
    });
    await this.runAutomations({ type: arrive ? 'contact.arrive' : 'contact.leave', contact: from, placeName: m.placeName, at });
  }

  private onLive(from: ContactKey, m: MessageOf<'live.start' | 'live.update' | 'live.end'>, at: number): void {
    const key = `live|${from}|${m.shareId}`;
    const prev = this.statuses.get(from)?.live;
    const same = prev?.shareId === m.shareId;
    if (m.type === 'live.end') {
      this.ended.add(key);
      if (same) this.setStatus(from, { live: undefined });
      return;
    }
    if (this.ended.has(key)) return;
    if (m.type === 'live.start') {
      if (m.expiresAt !== undefined && m.expiresAt <= at) return;
      this.setStatus(from, {
        live: {
          ...(same ? prev : {}),
          shareId: m.shareId,
          level: m.level,
          expiresAt: m.expiresAt,
          updatedAt: at,
          lastSentAt: same ? prev.lastSentAt : senderTime(m.sentAt, at),
        },
      });
      if (!same) {
        this.alert({
          category: 'live',
          title: `${this.name(from)} teilt den Standort mit dir`,
          body: m.level === 'precise' ? 'Genauer Standort, live' : 'Ungefähre Gegend (2 km), live',
          from,
          thread: from,
        });
      }
      return;
    }
    const sentAt = senderTime(m.sentAt, at);
    if (same && isOlder(sentAt, prev.lastSentAt, at)) return;
    // Updates that overtake their start message are kept as coarse until the start arrives.
    const base = same ? prev : { shareId: m.shareId, level: 'coarse' as const };
    const point = base.level === 'precise' ? m.point : undefined;
    if (!point && !m.cell) return;
    this.setStatus(from, {
      live: { ...base, ...(point ? { point } : {}), ...(m.cell ? { cell: m.cell } : {}), updatedAt: at, lastSentAt: sentAt },
    });
  }

  private async onCheckin(from: ContactKey, m: MessageOf<'checkin'>, at: number): Promise<void> {
    const text = checkinText(m.kind, m.text, m.placeName);
    this.setStatus(from, { lastCheckin: { kind: m.kind, text: m.text, placeName: m.placeName, at } });
    this.emit({ type: 'chat', thread: from, entry: { id: m.id, from, text, at, kind: 'ping' } });
    this.alert({ category: 'checkin', title: this.name(from), body: text, from, thread: from });
    await this.runAutomations({ type: 'contact.checkin', contact: from, kind: m.kind, text: m.text, placeName: m.placeName, at });
  }

  private onWatchStart(from: ContactKey, m: MessageOf<'watch.start'>, at: number): void {
    if (this.ended.has(`watch|${from}|${m.watchId}`)) return;
    // One that went overdue while I was offline still rings: it matters most then.
    if (m.dueAt <= at - WATCH_KEEP_MS || m.dueAt > at + MAX_WATCH_MS + HOUR) return;
    const watches = this.statuses.get(from)?.watches ?? [];
    const existing = watches.find((w) => w.watchId === m.watchId);
    const sentAt = senderTime(m.sentAt, at);
    // Relays may reorder: an older copy (from before the deadline moved) must not bring its time back.
    if (existing && isOlder(sentAt, existing.lastSentAt, at)) return;
    if (existing && existing.dueAt === m.dueAt && existing.label === m.label) return;
    if (!existing && watches.length >= MAX_WATCHES_PER_CONTACT) return;
    // A watch that already rang rings again only when its deadline really moves into the future.
    if (existing?.firedAt !== undefined && m.dueAt <= at) return;
    // Arrived after its deadline: rings a moment later, so a check-in caught up with it can cancel it.
    const ringAt = Math.max(m.dueAt, at + LATE_WATCH_GRACE_MS);
    // A deadline that moves before its alarm rang takes its place in the budget along.
    const rang = existing !== undefined && (existing.firedAt !== undefined || watchRingTime(existing) <= at);
    const moved = existing !== undefined && !rang && !existing.quiet ? watchRingTime(existing) : undefined;
    const loud = this.chargeLoudWatch(from, m.watchId, ringAt, at, moved);
    const next = {
      watchId: m.watchId,
      label: m.label,
      dueAt: m.dueAt,
      startedAt: existing?.startedAt ?? at,
      lastSentAt: sentAt,
      ...(ringAt > m.dueAt ? { ringAt } : {}),
      ...(loud ? {} : { quiet: true }),
    };
    this.setStatus(from, { watches: [...watches.filter((w) => w.watchId !== m.watchId), next] });
    this.emit({ type: 'alarm.schedule', alarm: this.watchAlarm(from, next) });
    this.alert({
      category: 'trip',
      title: existing ? `${this.name(from)} hat die Zeit geändert` : `${this.name(from)}: Pass auf mich auf`,
      body: `„${m.label}“, meldet sich bis ${this.hhmm(m.dueAt)}`,
      from,
      thread: from,
      ref: { watchId: m.watchId },
    });
  }

  /**
   * Whether a contact's watch alarm ringing at `ringAt` may be loud (watch alarms ring through
   * quiet mode): a few per contact within an hour of each other, counted by when they ring, so
   * checkpoints of a long hike planned ahead all stay loud while a flood of watches does not.
   * Past that they ring as a normal notification. `moved`: the earlier ring time of this watch,
   * whose place is freed because its deadline moved before it rang.
   */
  private chargeLoudWatch(from: ContactKey, watchId: string, ringAt: number, now: number, moved?: number): boolean {
    const rings = (this.loudWatchRings.get(from) ?? []).filter((r) => r.at > now - HOUR && !(r.watchId === watchId && r.at === moved));
    const loud = rings.filter((r) => Math.abs(r.at - ringAt) < HOUR).length < LOUD_WATCHES_PER_HOUR;
    if (loud) rings.push({ watchId, at: ringAt });
    if (rings.length) this.loudWatchRings.set(from, rings.slice(-200));
    else this.loudWatchRings.delete(from);
    return loud;
  }

  /** The alarm scheduled for a contact's watch, as loud as my settings allow when it rings. */
  private watchAlarm(key: ContactKey, w: NonNullable<ContactStatus['watches']>[number], prefs = this.state.prefs): Alarm {
    const at = watchRingTime(w);
    return {
      id: `watch:${key}:${w.watchId}`,
      at,
      title: `⏰ ${this.name(key)} hat sich nicht gemeldet`,
      body: `„${w.label}“ war bis ${this.hhmm(w.dueAt)} geplant. Frag nach, ob alles okay ist.`,
      level: alertLevel({ category: 'watch', overBudget: w.quiet }, prefs, isDndActive(prefs.dnd, at, this.localTime)),
    };
  }

  /**
   * Quiet mode or its rules changed: alarms scheduled ahead with the OS (they ring even with the
   * app closed) get the loudness they now should have.
   */
  private rescheduleWatchAlarms(before: NotificationPrefs): void {
    const now = this.now();
    for (const [key, status] of this.statuses) {
      for (const w of status.watches ?? []) {
        if (w.firedAt !== undefined || watchRingTime(w) <= now) continue;
        const alarm = this.watchAlarm(key, w);
        if (alarm.level !== this.watchAlarm(key, w, before).level) this.emit({ type: 'alarm.schedule', alarm });
      }
    }
  }

  private onWatchEnd(from: ContactKey, m: MessageOf<'watch.end'>): void {
    this.ended.add(`watch|${from}|${m.watchId}`);
    this.emit({ type: 'alarm.cancel', id: `watch:${from}:${m.watchId}` });
    const watches = this.statuses.get(from)?.watches ?? [];
    const w = watches.find((x) => x.watchId === m.watchId);
    if (!w) return;
    this.setStatus(from, { watches: watches.filter((x) => x.watchId !== m.watchId) });
    if (m.reason === 'ok') {
      this.alert({ category: 'checkin', title: this.name(from), body: `✅ hat sich gemeldet („${w.label}“)`, from, thread: from });
    }
  }

  private checkOverdueWatches(now: number): void {
    for (const [key, status] of [...this.statuses]) {
      if (!status.watches?.some((w) => !w.firedAt && now >= watchRingTime(w))) continue;
      const watches = status.watches.map((w) => {
        if (w.firedAt || now < watchRingTime(w)) return w;
        // Same id as the scheduled alarm, so the platform shows one notification, not two.
        this.alert({
          id: `watch:${key}:${w.watchId}`,
          category: 'watch',
          overBudget: w.quiet,
          title: `⏰ ${this.name(key)} hat sich nicht gemeldet`,
          body: `„${w.label}“ war bis ${this.hhmm(w.dueAt)} geplant. Frag nach, ob alles okay ist.`,
          from: key,
          thread: key,
          ref: { watchId: w.watchId },
        });
        return { ...w, firedAt: now };
      });
      this.setStatus(key, { watches });
    }
  }

  private async onSos(from: ContactKey, m: MessageOf<'sos.start' | 'sos.update' | 'sos.end'>, at: number): Promise<void> {
    const prev = this.statuses.get(from)?.sos;
    const same = prev?.sosId === m.sosId;
    if (m.type === 'sos.start') {
      // `endedAt` survives a restart, the `ended` list does not: a late copy must not revive it.
      if (this.ended.has(`sos|${from}|${m.sosId}`) || (same && prev.endedAt !== undefined)) return;
      const sentAt = senderTime(m.sentAt, at);
      // Relays hand stored messages over in any order. An older alert (say one pressed by accident
      // and cancelled) must not replace a newer one, and an older copy of this one (it is sent again
      // when pressed again) must not bring back its text and helpers.
      if (prev && !same && isOlder(sentAt, prev.lastSentAt, at)) return;
      if (same && isOlder(sentAt, prev.startSentAt, at)) return;
      // Sent before this device got the account (see `replaying`): relays hand over its end, if
      // there is one, in any order. It rings a moment later, from `tick`, only if none came by then.
      const history = this.replaying;
      if (history && !same && at - sentAt > SOS_KEEP_MS) return;
      // Nor its location, if a newer one came with an update in between.
      const newest = !same || !isOlder(sentAt, prev.lastSentAt, at);
      const point = newest && m.point ? m.point : same ? prev.point : undefined;
      // Pressed again since: it rings now, like any new SOS.
      const ringAt = same ? (history ? prev.ringAt : undefined) : history ? at + HISTORY_SOS_WAIT_MS : undefined;
      this.setStatus(from, {
        sos: {
          sosId: m.sosId,
          // An old one keeps its own age, so it is dropped when an open SOS would have been.
          startedAt: same ? prev.startedAt : history ? Math.min(sentAt, at) : at,
          text: m.text,
          point,
          pointAt: point && point === m.point ? at : same ? prev.pointAt : undefined,
          others: m.others.filter((o) => o.key !== this.state.self.key && o.key !== from),
          acks: same ? prev.acks : [],
          lastSentAt: newest ? sentAt : prev.lastSentAt,
          startSentAt: sentAt,
          ...(ringAt !== undefined ? { ringAt } : {}),
        },
      });
      if (history || (same && prev.ringAt === undefined)) return;
      this.sosAlarm(from, m.sosId, m.text, m.point !== undefined, at);
      if (!same) await this.runAutomations({ type: 'contact.sos', contact: from, at });
      return;
    }
    if (m.type === 'sos.update') {
      if (!same || prev.endedAt) return;
      let next = prev;
      const sentAt = senderTime(m.sentAt, at);
      if (m.point && !isOlder(sentAt, prev.lastSentAt, at)) next ={ ...next, point: m.point, pointAt: at, lastSentAt: sentAt };
      if (m.acks) {
        const acks = [...next.acks];
        for (const a of m.acks) {
          // Bounded: every update may name 20 new helpers, and the sender can send as many as it likes.
          if (acks.length >= MAX_SOS_ACKS) break;
          if (a.key === this.state.self.key || acks.some((x) => x.key === a.key)) continue;
          acks.push({ key: a.key, name: this.contact(a.key) ? this.name(a.key) : a.name, at, text: a.text });
          this.alert({ category: 'sos', followUp: true, title: `${a.name} kümmert sich um ${this.name(from)}`, body: a.text ?? 'Hilfe ist unterwegs.', from, thread: from, ref: { sosId: m.sosId, sosOwner: from } });
        }
        next = { ...next, acks };
      }
      if (next !== prev) this.setStatus(from, { sos: next });
      return;
    }
    this.ended.add(`sos|${from}|${m.sosId}`);
    if (!same || prev.endedAt) return;
    const { ringAt, ...ended } = prev;
    this.setStatus(from, { sos: { ...ended, endedAt: at, endReason: m.reason } });
    // Its alarm never rang here (it came from before this device got the account): nothing to call off.
    if (ringAt !== undefined) return;
    this.alert({
      category: 'sos',
      followUp: true,
      title: m.reason === 'safe' ? `✅ ${this.name(from)} ist in Sicherheit` : `${this.name(from)} hat den Notruf abgebrochen`,
      body: m.reason === 'safe' ? 'Der Notruf ist beendet.' : 'Es war wohl ein Versehen.',
      from,
      thread: from,
      ref: { sosId: m.sosId, sosOwner: from },
    });
  }

  /** An SOS always rings. Only a flood of them from one person is turned down to a normal notification, which still nothing can switch off. */
  private sosAlarm(from: ContactKey, sosId: string, text: string | undefined, withPoint: boolean, at: number): void {
    const alarm = this.sosAlarmLimiter.allow(from, at);
    this.alert({
      id: `sos:${from}:${sosId}`,
      category: 'sos',
      overBudget: !alarm,
      title: `🆘 ${this.name(from)} braucht Hilfe!`,
      body: text ?? (withPoint ? 'Der Standort ist dabei. Tippe, um ihn zu sehen.' : 'Bitte melde dich sofort.'),
      from,
      thread: from,
      ref: { sosId, sosOwner: from },
    });
  }

  /** Rings an SOS sent before this device got the account once its wait is over and no end came. */
  private ringHeldSos(now: number): void {
    for (const [key, status] of [...this.statuses]) {
      const sos = status.sos;
      if (sos?.ringAt === undefined || now < sos.ringAt || sos.endedAt !== undefined) continue;
      const { ringAt: _rung, ...rest } = sos;
      this.setStatus(key, { sos: rest });
      this.sosAlarm(key, sos.sosId, sos.text, sos.point !== undefined, now);
    }
  }

  private onSosAck(from: ContactKey, m: MessageOf<'sos.ack'>, at: number): void {
    const name = this.name(from);
    if (m.owner === this.state.self.key) {
      const sos = this.state.sos;
      if (!sos || sos.sosId !== m.sosId || !sos.recipients.includes(from)) return;
      const first = !sos.acks.some((a) => a.key === from);
      const acks = [...sos.acks.filter((a) => a.key !== from), { key: from, at, text: m.text }];
      this.update({ sos: { ...sos, acks } });
      this.alert({ category: 'sos', followUp: true, title: `${name} kümmert sich`, body: m.text ?? 'Hilfe ist unterwegs.', from, thread: from, ref: { sosId: m.sosId, sosOwner: this.state.self.key } });
      // Tell the other helpers, who may not be contacts of each other.
      if (first) {
        const list = acks.slice(-20).map((a) => ({ key: a.key, name: this.contact(a.key)?.name ?? 'Jemand', ...(a.text ? { text: a.text } : {}) }));
        void this.sendMany(sos.recipients.filter((k) => k !== from), { type: 'sos.update', sosId: sos.sosId, acks: list }, TTL.sos);
      }
      return;
    }
    const sos = this.statuses.get(m.owner)?.sos;
    if (!sos || sos.sosId !== m.sosId || sos.endedAt || !sos.others.some((o) => o.key === from)) return;
    this.setStatus(m.owner, { sos: { ...sos, acks: [...sos.acks.filter((a) => a.key !== from), { key: from, name, at, text: m.text }] } });
    this.alert({
      category: 'sos',
      followUp: true,
      title: `${name} kümmert sich um ${this.name(m.owner)}`,
      body: m.text ?? 'Hilfe ist unterwegs.',
      from,
      thread: m.owner,
      ref: { sosId: m.sosId, sosOwner: m.owner },
    });
  }

  private onWhereRequest(from: ContactKey, m: MessageOf<'where.request'>, at: number): void {
    const chat: NodeEvent = { type: 'chat', thread: from, entry: { id: m.id, from, text: '📍 Wo bist du?', at, kind: 'ping' } };
    // Asked before this device got the account: answered (or not) on my other device back then.
    if (this.replaying) return this.emit(chat);
    if (!this.whereLimiter.allow(from, at)) return;
    this.update({
      whereInbox: [...this.state.whereInbox.filter((w) => w.from !== from && at - w.at < DAY), { from, requestId: m.requestId, at }].slice(-50),
    });
    this.emit(chat);
    this.alert({
      category: 'where',
      title: `${this.name(from)} fragt: Wo bist du?`,
      body: 'Tippe, um zu antworten. Du entscheidest, was du teilst.',
      from,
      thread: from,
      ref: { requestId: m.requestId },
    });
  }

  private onWhereReply(from: ContactKey, m: MessageOf<'where.reply'>, at: number): void {
    const asked = this.state.whereAsked.find((w) => w.from === from && w.requestId === m.requestId);
    if (!asked) return;
    this.update({ whereAsked: this.state.whereAsked.filter((w) => w !== asked) });
    this.setStatus(from, {
      lastWhere: {
        requestId: m.requestId,
        answer: m.answer,
        text: m.text,
        placeName: m.placeName,
        etaMinutes: m.etaMinutes,
        cell: m.answer === 'coarse' ? m.cell : undefined,
        point: m.answer === 'precise' ? m.point : undefined,
        at,
      },
    });
    const text = whereText(m);
    this.emit({ type: 'chat', thread: from, entry: { id: m.id, from, text, at, kind: 'ping' } });
    this.alert({ category: 'where', title: this.name(from), body: text, from, thread: from });
  }

  private onGroupUpdate(from: ContactKey, m: MessageOf<'group.update'>): Promise<void> | void {
    if (m.owner !== from) return;
    const g = this.group(m.groupId);
    if (g && (g.owner !== from || m.version <= g.version)) return;
    const meIn = m.members.some((x) => x.key === this.state.self.key);
    if (!g) {
      if (this.state.leftGroups.some((x) => x.id === m.groupId)) {
        // I left it myself. An owner who adds me back (or never heard that I left) learns it
        // again, so their list does not keep showing someone who gets nothing.
        if (meIn && !m.dissolved && !this.replaying) return this.sendTo(from, { type: 'group.leave', groupId: m.groupId }, TTL.chat).then(() => undefined);
        return;
      }
      if (!meIn || m.dissolved || !this.contact(from) || this.liveGroups().length >= MAX_GROUPS) return;
      this.joinGroup(from, m, undefined);
      return;
    }
    if (m.dissolved) {
      this.update({
        groups: this.state.groups.filter((x) => x.id !== m.groupId),
        leftGroups: [...this.state.leftGroups.filter((x) => x.id !== m.groupId), { id: m.groupId, at: this.now() }].slice(-200),
      });
      this.markSync();
      if (!g.dissolved) this.alert({ category: 'group', title: m.name, body: 'Die Gruppe wurde aufgelöst.', from, ref: { groupId: m.groupId } });
      return;
    }
    if (!meIn) {
      // Taken off by the owner: kept hidden with its version (see `Group.dissolved`), so an older
      // roster cannot bring me back, but the owner adding me again later can.
      const out: Group = {
        id: m.groupId,
        name: m.name,
        owner: from,
        members: m.members.filter((x) => x.key === from),
        version: m.version,
        updatedAt: this.now(),
        dissolved: true,
      };
      this.update({ groups: this.state.groups.map((x) => (x.id === m.groupId ? out : x)) });
      this.markSync();
      if (!g.dissolved) this.alert({ category: 'group', title: m.name, body: 'Du bist nicht mehr in dieser Gruppe.', from, ref: { groupId: m.groupId } });
      return;
    }
    // Back in after being taken off: like joining, only a contact can add me.
    if (g.dissolved && !this.contact(from)) return;
    this.joinGroup(from, m, g);
  }

  /** Takes a roster that lists me; `g` is my copy, if I had one (also a hidden one, see `Group.dissolved`). */
  private joinGroup(from: ContactKey, m: MessageOf<'group.update'>, g: Group | undefined): void {
    const next: Group = { id: m.groupId, name: m.name, owner: m.owner, members: m.members, version: m.version, updatedAt: this.now() };
    this.update({ groups: g ? this.state.groups.map((x) => (x.id === m.groupId ? next : x)) : capGroups([...this.state.groups, next], MAX_GROUPS) });
    this.markSync();
    if (g && !g.dissolved) return;
    this.alert({
      category: 'group',
      title: m.name,
      body: `${this.name(from)} hat dich zur Gruppe hinzugefügt.`,
      from,
      thread: `g:${m.groupId}`,
      ref: { groupId: m.groupId },
    });
  }

  private onGroupText(from: ContactKey, m: MessageOf<'group.text'>, at: number): void {
    const g = this.group(m.groupId);
    if (!g || g.dissolved || !this.isMember(m.groupId, from)) return;
    const urgent = this.isUrgent(from, m.urgent, at);
    const thread = `g:${m.groupId}`;
    this.emit({ type: 'chat', thread, entry: { id: m.id, from, text: m.text, at, kind: 'text', urgent: urgent || undefined } });
    this.alert({ category: 'group', title: `${this.name(from)} in ${g.name}`, body: m.text, from, thread, urgent, ref: { groupId: g.id } });
  }

  private async onGroupLeave(from: ContactKey, m: MessageOf<'group.leave'>): Promise<void> {
    const g = this.group(m.groupId);
    if (!g || g.owner !== this.state.self.key || !this.isMember(m.groupId, from)) return;
    const next: Group = { ...g, members: g.members.filter((x) => x.key !== from), version: g.version + 1, updatedAt: this.now() };
    this.update({ groups: this.state.groups.map((x) => (x.id === g.id ? next : x)) });
    this.markSync();
    this.alert({ category: 'group', title: g.name, body: `${this.name(from)} hat die Gruppe verlassen.`, thread: `g:${g.id}`, ref: { groupId: g.id } });
    await this.broadcastRoster(next, []);
  }

  // ---- automations -----------------------------------------------------------------------------

  private async runAutomations(event: AutomationEvent): Promise<void> {
    // Something from before this device got the account: my other device acted on it back then.
    if (this.replaying) return;
    // My other devices got the same message and have the same rules: only one acts for others.
    const onlyHere = event.type.startsWith('contact.') && !this.runsAutomationActions;
    // Limits by my clock: a place event carries the time of its fix, which may come late.
    for (const intent of this.engine.handle(event, this.now())) {
      if (onlyHere && !isLocalIntent(intent, this.state.prefs)) continue;
      // In ghost mode, rules that depend on where I am may only act on this device.
      if (this.state.ghost && !isLocalIntent(intent, this.state.prefs) && this.usesMyLocation(intent.ruleId)) continue;
      try {
        switch (intent.kind) {
          case 'notify':
            this.alert({ category: 'automation', title: intent.title, body: intent.body });
            break;
          case 'send_ping':
            await this.sendPing(intent.to, intent.pingKind, intent.text);
            break;
          case 'send_message':
            await this.sendChat(intent.to, intent.text);
            break;
          case 'send_checkin':
            // Never adds the place I'm at by itself: nobody looks at the message before it goes.
            // It ends my watches only when I arrived at one of my places, and only those whose
            // people all get it: a rule a contact can set off must not tell them I'm fine.
            await this.checkin(
              { to: intent.to, kind: intent.checkinKind, text: intent.text },
              { addPlace: false, ends: event.type === 'me.arrive' ? 'covered' : 'none' },
            );
            break;
          case 'set_dnd':
            await this.setDnd(intent.minutes);
            break;
          case 'set_status':
            await this.setMyStatus({ text: intent.text, emoji: intent.emoji, hours: intent.hours });
            break;
          case 'start_trip': {
            const place = this.state.places.find((p) => p.id === intent.destination);
            if (!place || this.activeTrip) break;
            await this.startTrip({ recipients: intent.to, destinationName: place.name, destination: place.center, level: intent.level });
            break;
          }
        }
      } catch {
        // A failing action (e.g. a removed contact) must not stop the others.
      }
    }
  }

  private usesMyLocation(ruleId: string): boolean {
    const r = this.state.rules.find((x) => x.id === ruleId);
    return !r || r.trigger.on.startsWith('me.') || r.conditions.some((c) => c.if === 'me.at' || c.if === 'me.not_at');
  }

  // ---- sending ---------------------------------------------------------------------------------

  private async broadcastTrip(body: AppMessageBody): Promise<void> {
    const session = this.trip?.session;
    if (!session) return;
    const now = this.now();
    const to = session.recipients.filter((k) =>
      body.type === 'session.update'
        ? this.policy.canSendSessionUpdate(k, session, body, now)
        : this.policy.canSendSessionLifecycle(k, session),
    );
    await this.sendMany(to, body, TTL.trip);
  }

  /** Where I was during a trip that ended never goes out after its end (e.g. once the phone is back online). */
  private dropQueuedTripUpdates(sessionId: string): void {
    this.dropQueued((e) => e.message.type === 'session.update' && e.message.sessionId === sessionId);
  }

  private afterTripEnded(): void {
    const trip = this.trip;
    if (trip) this.dropQueuedTripUpdates(trip.session.id);
    this.emit({ type: 'trip', session: undefined });
    this.emitLocationNeeds();
    if (trip?.endReason === 'arrived') {
      for (const w of this.state.watches.filter((x) => x.tripId === trip.session.id)) void this.endWatch(w.watchId, 'ok');
    }
  }

  private presenceBody(): BodyOf<'presence'> {
    const now = this.now();
    const s = this.state.status && this.state.status.expiresAt > now ? this.state.status : undefined;
    const status = s ? { ...(s.text ? { text: s.text } : {}), ...(s.emoji ? { emoji: s.emoji } : {}), expiresAt: s.expiresAt } : null;
    let dnd: BodyOf<'presence'>['dnd'] = null;
    if (this.state.prefs.dnd.share && this.dndActive()) {
      const until = this.dndEndsAt();
      dnd = until !== undefined ? { until } : {};
    }
    return { type: 'presence', status, dnd };
  }

  /** Tells all contacts my status and quiet mode, but only when it changed. */
  private async broadcastPresence(): Promise<void> {
    const body = this.presenceBody();
    const key = JSON.stringify(body);
    if (key === this.lastPresence) return;
    const first = this.lastPresence === '';
    this.lastPresence = key;
    // Right after start nothing is sent unless there is something to say.
    if (first && !body.status && !body.dnd) return;
    await this.sendMany(this.contactKeys(), body, TTL.presence);
  }

  /** Sends one message to one person. Returns its id, or undefined if they can't be reached. */
  private async sendTo(to: ContactKey, body: AppMessageBody, ttlSeconds: number): Promise<string | undefined> {
    if (!this.contact(to)) return undefined;
    const message = composeMessage(body, this.now());
    await this.deliver(to, message, ttlSeconds);
    return message.id;
  }

  /** Sends the same message to several people in parallel. Returns the message id. */
  private async sendMany(to: ContactKey[], body: AppMessageBody, ttlSeconds: number, allowMembers = false): Promise<string> {
    const message = composeMessage(body, this.now());
    const targets = [...new Set(to)].filter(
      (k) => k !== this.state.self.key && (this.contact(k) !== undefined || (allowMembers && this.relaysFor(k).length > 0)),
    );
    await Promise.all(targets.map((k) => this.deliver(k, message, ttlSeconds)));
    return message.id;
  }

  private async sendToSelf(body: AppMessageBody, ttlSeconds: number): Promise<void> {
    await this.deliver(this.state.self.key, composeMessage(body, this.now()), ttlSeconds);
  }

  /** `relays`: where to send it instead of the recipient's known relays, also when it is retried later. */
  private async deliver(to: ContactKey, message: AppMessage, ttlSeconds: number, relays?: string[]): Promise<void> {
    const via = relays?.length ? relays : undefined;
    try {
      await this.transport.send(to, message, { ttlSeconds, ...(via ? { relays: via } : {}) });
      this.unreachable.delete(to);
    } catch {
      // Not offline but unsendable (e.g. a relay address the wire rejects): retrying cannot help.
      if (!isSendable(message)) return;
      const now = this.now();
      this.enqueue({ to, message, ttlSeconds, firstAt: now, attempts: 1, nextAt: now + 15_000, ...(via ? { relays: via } : {}) });
    }
  }

  private dropQueued(drop: (e: OutboxEntry) => boolean): void {
    const outbox = this.state.outbox.filter((e) => !drop(e));
    if (outbox.length !== this.state.outbox.length) this.update({ outbox });
  }

  private enqueue(entry: OutboxEntry): void {
    let outbox = this.state.outbox;
    if (REPLACEABLE.has(entry.message.type)) {
      const k = replaceKey(entry);
      outbox = outbox.filter((e) => replaceKey(e) !== k);
    }
    this.update({ outbox: [...outbox, entry].slice(-MAX_OUTBOX) });
  }

  private recordSent(thread: string, id: string, text: string, kind: 'text' | 'ping', urgent?: boolean): void {
    const at = this.now();
    this.emit({ type: 'chat', thread, entry: { id, from: 'me', text, at, kind, urgent: urgent || undefined } });
    if (!this.state.devices.length) return;
    void this.sendToSelf(
      { type: 'sync.sent', deviceId: this.state.self.deviceId, thread, msgId: safeId(id), text: text.slice(0, 4000), kind, at },
      TTL.sync,
    );
  }

  // ---- helpers ---------------------------------------------------------------------------------

  /**
   * `followUp` marks news about an emergency that already rang (a helper is on the way, the
   * person is safe): it comes through quiet mode and can't be switched off like the SOS itself,
   * but as a normal notification, not a second alarm.
   */
  private alert(
    input: Omit<Alert, 'id' | 'at' | 'level'> & { id?: string; urgent?: boolean; followUp?: boolean; overBudget?: boolean },
  ): void {
    // From before this device got the account: my other device showed it back then. Its time
    // here would be wrong too, so it does not even go into the activity list.
    if (this.replaying) return;
    const now = this.now();
    const { urgent, id, followUp, overBudget, ...rest } = input;
    const c = input.from ? this.contact(input.from) : undefined;
    let level: AlertLevel = followUp
      ? 'normal'
      : alertLevel({ category: input.category, favorite: c?.favorite, muted: c?.muted, urgent, overBudget }, this.state.prefs, this.dndActive());
    const critical = input.category === 'sos' || input.category === 'watch';
    if (!critical && input.from && level !== 'feed' && !this.alertLimiter.allow(input.from, now)) level = 'feed';
    this.emit({ type: 'alert', alert: { ...rest, id: id ?? randomId(), at: now, level } });
  }

  private addContact(input: { key: ContactKey; name: string; relays: string[] }): Contact {
    const existing = this.contact(input.key);
    if (existing) return existing;
    if (this.state.contacts.length >= MAX_CONTACTS) throw new RangeError('Du hast die maximale Anzahl an Kontakten erreicht.');
    const now = this.now();
    // Newer than an old removal, which may come from a device whose clock runs ahead.
    const removedAt = this.state.removedContacts.find((t) => t.key === input.key)?.at ?? 0;
    const contact: Contact = { ...input, addedAt: now, verified: false, updatedAt: Math.max(now, removedAt + 1) };
    this.update({
      contacts: [...this.state.contacts, contact],
      removedContacts: this.state.removedContacts.filter((t) => t.key !== input.key),
    });
    this.markSync();
    this.emit({ type: 'contact.added', contact });
    this.alert({ category: 'contact', title: 'Neuer Kontakt', body: `${input.name} ist jetzt in deinen Kontakten.`, thread: input.key });
    // A new contact learns my current status right away.
    const presence = this.presenceBody();
    if (presence.status || presence.dnd) void this.sendTo(input.key, presence, TTL.presence);
    return contact;
  }

  private editContact(key: ContactKey, patch: Partial<Contact>): void {
    if (!this.contact(key)) return;
    const now = this.now();
    // Newest wins when my devices sync. Always newer than the last change, even one made on a
    // device whose clock runs ahead, or this edit would be overwritten by the older one.
    const edit = (c: Contact) => stripUndefined({ ...c, ...patch, updatedAt: Math.max(now, stampOf(c) + 1) });
    this.update({ contacts: this.state.contacts.map((c) => (c.key === key ? edit(c) : c)) });
    this.markSync();
  }

  private contact(key: ContactKey): Contact | undefined {
    return this.state.contacts.find((c) => c.key === key);
  }

  private contactKeys(): ContactKey[] {
    return this.state.contacts.map((c) => c.key);
  }

  private group(id: string): Group | undefined {
    return this.state.groups.find((g) => g.id === id);
  }

  private isMember(groupId: string, key: ContactKey): boolean {
    const g = this.group(groupId);
    return !!g && !g.dissolved && g.members.some((m) => m.key === key);
  }

  private dndActive(): boolean {
    return isDndActive(this.state.prefs.dnd, this.now(), this.localTime);
  }

  private hhmm(at: number): string {
    const m = this.localTime(at).minutes;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  private setStatus(key: ContactKey, patch: Partial<ContactStatus>): void {
    const status: ContactStatus = { ...this.statuses.get(key), ...patch };
    for (const k of Object.keys(patch) as (keyof ContactStatus)[]) if (patch[k] === undefined) delete status[k];
    this.statuses.set(key, status);
    this.emit({ type: 'status', contact: key, status });
  }

  private pruneStatuses(now: number): void {
    for (const [key, s] of [...this.statuses]) {
      const patch: Partial<ContactStatus> = {};
      if (s.trip && now > s.trip.expiresAt + 10 * 60_000) patch.trip = undefined;
      if (s.live?.expiresAt !== undefined && now > s.live.expiresAt) patch.live = undefined;
      if (s.presence) {
        const p = { ...s.presence };
        if (p.status && now >= p.status.expiresAt) delete p.status;
        if (p.dnd?.until !== undefined && now >= p.dnd.until) delete p.dnd;
        if (JSON.stringify(p) !== JSON.stringify(s.presence)) patch.presence = p;
      }
      if (s.sos && ((s.sos.endedAt !== undefined && now - s.sos.endedAt > DAY) || now - s.sos.startedAt > SOS_KEEP_MS)) patch.sos = undefined;
      if (s.watches?.some((w) => now > watchRingTime(w) + WATCH_KEEP_MS)) {
        patch.watches = s.watches.filter((w) => now <= watchRingTime(w) + WATCH_KEEP_MS);
      }
      if (Object.keys(patch).length) this.setStatus(key, patch);
    }
  }

  private pruneLists(now: number): void {
    const patch: Partial<NodeState> = {};
    const whereInbox = this.state.whereInbox.filter((w) => now - w.at < DAY);
    if (whereInbox.length !== this.state.whereInbox.length) patch.whereInbox = whereInbox;
    const whereAsked = this.state.whereAsked.filter((w) => now - w.at < DAY);
    if (whereAsked.length !== this.state.whereAsked.length) patch.whereAsked = whereAsked;
    const openInvites = this.state.openInvites.filter((i) => i.expiresAt > now);
    if (openInvites.length !== this.state.openInvites.length) patch.openInvites = openInvites;
    const leftGroups = this.state.leftGroups.filter((g) => now - g.at < 180 * DAY);
    if (leftGroups.length !== this.state.leftGroups.length) patch.leftGroups = leftGroups;
    const groups = this.state.groups.filter((g) => !g.dissolved || now - g.updatedAt < 180 * DAY);
    if (groups.length !== this.state.groups.length) patch.groups = groups;
    if (Object.keys(patch).length) this.update(patch);
  }

  private markSync(): void {
    if (!this.state.devices.length) return;
    this.syncDue = true;
    const delay = this.options.syncDelayMs ?? 2000;
    if (delay > 0 && !this.syncTimer && this.running) {
      this.syncTimer = setTimeout(() => {
        this.syncTimer = undefined;
        void this.flushSync();
      }, delay);
    }
  }

  private update(patch: Partial<NodeState>, syncFields: SyncField[] = []): void {
    const before = this.state;
    let next: NodeState = { ...this.state, ...patch };
    if (syncFields.length) {
      const rev = { ...next.syncRev };
      for (const f of syncFields) rev[f] = Math.max(this.now(), (rev[f] ?? 0) + 1);
      next = { ...next, syncRev: rev };
    }
    this.state = next;
    this.emit({ type: 'state', state: this.state });
    // From any source: settings, quiet mode by hand or automation, its end, my other device.
    if (next.prefs !== before.prefs) this.rescheduleWatchAlarms(before.prefs);
    if (syncFields.length) this.markSync();
    if (next.contacts !== before.contacts || next.groups !== before.groups) this.redeliverSoon();
  }

  /**
   * Someone new may be accepted now (a contact from my other device's sync, a member from a group
   * update): the transport hands on again what it turned away from them a moment ago. Deferred,
   * so it never runs in the middle of handling the message that caused it.
   */
  private redeliverSoon(): void {
    if (this.redeliverQueued || !this.transport.redeliverRefused) return;
    this.redeliverQueued = true;
    queueMicrotask(() => {
      this.redeliverQueued = false;
      if (this.running) this.transport.redeliverRefused?.();
    });
  }

  private emitLocationNeeds(): void {
    const needs = this.locationNeeds();
    const key = JSON.stringify(needs);
    if (key === this.lastNeeds) return;
    this.lastNeeds = key;
    this.emit({ type: 'location', needs });
  }

  private emit(e: NodeEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // A broken listener must not break the node.
      }
    }
  }
}

function rosterBody(g: Group): BodyOf<'group.update'> {
  return {
    type: 'group.update',
    groupId: g.id,
    name: g.name,
    owner: g.owner,
    members: g.members.map((m) => {
      // A relay the wire rejects (e.g. from an old QR code) would make the whole roster unsendable.
      const relays = (m.relays ?? []).filter((r) => RelayUrl.safeParse(r).success).slice(0, 8);
      return { key: m.key, name: m.name, ...(relays.length ? { relays } : {}) };
    }),
    version: g.version,
  };
}

function replaceKey(e: OutboxEntry): string {
  const m = e.message as { type: string; sessionId?: string; shareId?: string; sosId?: string };
  const acksOnly = m.type === 'sos.update' && !(e.message as { point?: unknown }).point ? '|acks' : '';
  return `${e.to}|${m.type}|${m.sessionId ?? m.shareId ?? m.sosId ?? ''}${acksOnly}`;
}

function stampOf(c: Contact): number {
  return c.updatedAt ?? c.addedAt;
}

/** The sender's clock, capped a little ahead of mine, so a clock that ran fast cannot freeze later updates. */
function senderTime(sentAt: number, at: number): number {
  return Math.min(sentAt, at + MAX_CLOCK_AHEAD_MS);
}

/**
 * Whether a contact's message (its `senderTime`) is older than the last one I took, so relays
 * that reorder cannot bring back an old state. The order is trusted only while the last time is
 * not clearly ahead of my clock. A last time further ahead means either the sender's clock ran
 * fast (and may have been corrected since) or my clock was set back: then the new message
 * counts, instead of none for up to `MAX_CLOCK_AHEAD_MS`. Exact replays are still caught by the
 * seen stores.
 */
function isOlder(sentAt: number, lastSentAt: number | undefined, at: number): boolean {
  return lastSentAt !== undefined && sentAt < lastSentAt && lastSentAt <= at + ORDER_TRUST_AHEAD_MS;
}

/** Actions that tell nobody anything: quiet mode counts only while it is not shared with contacts. */
function isLocalIntent(intent: ActionIntent, prefs: NotificationPrefs): boolean {
  return intent.kind === 'notify' || (intent.kind === 'set_dnd' && !prefs.dnd.share);
}

function toPoint(fix: LocationFix): Point {
  return { lat: fix.lat, lon: fix.lon, accuracyM: Math.min(Math.max(fix.accuracyM ?? 50, 0), 10_000) };
}

function cleanText(text: string, max: number): string {
  const t = text.trim();
  if (!t) throw new RangeError('Der Text darf nicht leer sein.');
  if (t.length > max) throw new RangeError(`Der Text ist zu lang (höchstens ${max} Zeichen).`);
  return t;
}

function safeId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return clean.length >= 8 ? clean : randomId();
}

/**
 * Screens offer exactly 5 minutes and add it to the time they read a moment before the node reads
 * it again; without this slack such a watch failed whenever the clock ticked in between.
 */
const WATCH_TIME_SLACK_MS = 5_000;

function checkWatchTime(dueAt: number, now: number): void {
  if (!Number.isFinite(dueAt) || dueAt < now + MIN_WATCH_MS - WATCH_TIME_SLACK_MS || dueAt > now + MAX_WATCH_MS) {
    throw new RangeError('Die Zeit muss zwischen 5 Minuten und 48 Stunden in der Zukunft liegen.');
  }
}

/** When a contact's watch alarm rings: at its deadline, or a moment after it arrived if that was later. */
function watchRingTime(w: { dueAt: number; ringAt?: number }): number {
  return Math.max(w.dueAt, w.ringAt ?? 0);
}

function watchTtl(dueAt: number, now: number): number {
  return Math.ceil((dueAt - now) / 1000) + 6 * 3600;
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function inviteError(e: string): string {
  if (e.includes('expired')) return 'Der Code ist abgelaufen. Lass einen neuen anzeigen.';
  if (e.includes('damaged')) return 'Der Code ist beschädigt.';
  return 'Das ist kein Kontakt-Code von Heyda.';
}

/** One line for a where-answer, for chats and notifications. */
export function whereText(m: { answer: string; text?: string; placeName?: string; etaMinutes?: number }): string {
  const extra = m.text && m.answer !== 'text' ? ` „${m.text}“` : '';
  switch (m.answer) {
    case 'declined':
      return `🙊 möchte gerade nicht sagen, wo${extra}`;
    case 'text':
      return `📍 ${m.text ?? ''}`;
    case 'place':
      return `📍 bei ${m.placeName ?? '…'}${extra}`;
    case 'eta':
      return `🚶 unterwegs nach ${m.placeName ?? '…'}${m.etaMinutes !== undefined ? `, in ca. ${m.etaMinutes} min da` : ''}${extra}`;
    case 'coarse':
      return `🗺️ ungefähre Gegend geschickt${extra}`;
    case 'precise':
      return `📍 genauen Standort geschickt${extra}`;
    default:
      return '📍';
  }
}
