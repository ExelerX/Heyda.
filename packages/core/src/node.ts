import { AutomationEngine, systemLocalTime, type AutomationEvent, type LocalTime } from './automation/engine';
import type { Rule } from './automation/schema';
import { checkinText, pingText } from './features/labels';
import { LIVE_CADENCE, LiveTracker, SOS_CADENCE } from './features/live';
import { GeofenceTracker, type Place } from './geo/geofence';
import type { LatLon, LocationFix } from './geo/types';
import { alertLevel, dndEndsAt, isDndActive, normalizePrefs, type AlertLevel, type NotificationPrefs } from './notify/prefs';
import { decodeInvite, encodeInvite, INVITE_TTL_MS } from './pairing/invite';
import { snapToGrid } from './privacy/coarse-grid';
import { PrivacyPolicy, type PlaceGrant } from './privacy/policy';
import { composeMessage } from './protocol/compose';
import {
  MAX_GROUP_MEMBERS,
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
  contactLabel,
  type Alert,
  type Contact,
  type ContactStatus,
  type Group,
  type GroupMember,
  type LinkedDevice,
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
import { decodeLinkInvite, linkCode } from './sync/link';
import { chunkPayload, Reassembler } from './sync/xfer';
import type { ContactKey, IncomingMessage, Transport } from './transport/transport';
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
  | { type: 'state'; state: NodeState };

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
const SOS_LOCATION_MS = 60 * 60_000;
const FRESH_FIX_MS = 2 * 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Message types whose newer copy replaces an older one still waiting in the outbox. */
const REPLACEABLE = new Set(['presence', 'session.update', 'live.update', 'sos.update']);

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
  /** Trips, live shares, watches and SOS alerts that ended, so late messages can't revive them. */
  private readonly ended = new RecentIds(1000);
  /** Per sender: notifications in a short window. More only land in the activity list. */
  private readonly alertLimiter = new RateLimiter(20, 10 * 60_000);
  private readonly urgentLimiter = new RateLimiter(3, HOUR);
  private readonly sosAlarmLimiter = new RateLimiter(6, HOUR);
  private readonly whereLimiter = new RateLimiter(5, HOUR);
  private readonly askLimiter = new RateLimiter(5, HOUR);
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
      placeName: (id) => this.state.places.find((p) => p.id === id)?.name,
      isAtPlace: (id) => this.geofence.isInside(id),
      localTime: this.localTime,
    });
    for (const [key, status] of Object.entries(options.initialStatuses ?? {})) {
      if (this.contact(key) && status && typeof status === 'object') this.statuses.set(key, status);
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
    this.lastDndActive = this.dndActive();
    this.emitLocationNeeds();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    this.unsubscribe?.();
    await this.transport.stop();
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
    const live = this.state.ghost ? [] : this.state.liveShares.filter((s) => !s.expiresAt || now < s.expiresAt);
    if (live.length) reasons.push('live');
    if (this.state.sos && now < this.state.sos.locationUntil) reasons.push('sos');
    const high = reasons.includes('trip') || reasons.includes('sos') || live.some((s) => s.level === 'precise');
    return { mode: high ? 'high' : reasons.length ? 'low' : 'off', reasons };
  }

  /** The place I'm at right now, if any. */
  currentPlace(): Place | undefined {
    return this.state.places.find((p) => this.geofence.isInside(p.id));
  }

  /** The newest location fix, if it is recent enough to share. */
  freshFix(maxAgeMs = FRESH_FIX_MS): LocationFix | undefined {
    return this.lastFix && this.now() - this.lastFix.timestamp < maxAgeMs ? this.lastFix : undefined;
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
    if (ghost) await this.stopLive();
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
    if (!this.contact(key)) return;
    if (this.state.liveShares.some((s) => s.contactKey === key)) await this.stopLive(key);
    for (const w of this.statuses.get(key)?.watches ?? []) this.emit({ type: 'alarm.cancel', id: `watch:${key}:${w.watchId}` });
    this.statuses.delete(key);
    this.update({
      contacts: this.state.contacts.filter((c) => c.key !== key),
      removedContacts: [...this.state.removedContacts.filter((t) => t.key !== key), { key, at: this.now() }].slice(-1000),
      grants: this.state.grants.filter((g) => g.contactKey !== key),
      whereInbox: this.state.whereInbox.filter((w) => w.from !== key),
    });
    this.markSync();
  }

  // ---- trips ---------------------------------------------------------------------------------

  async startTrip(input: {
    recipients: ContactKey[];
    destinationName: string;
    destination?: LatLon;
    level?: SessionLevel;
    durationMs?: number;
  }): Promise<SharingSession> {
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
    await this.broadcastTrip(this.trip.stopMessage());
    this.afterTripEnded();
  }

  /** Picks up a trip that was running before the app restarted. Sends nothing. */
  resumeTrip(session: SharingSession): boolean {
    if (this.activeTrip || !isSessionActive(session, this.now())) return false;
    const recipients = session.recipients.filter((k) => this.contact(k));
    if (!recipients.length) return false;
    this.trip = new TripSharer({ ...session, recipients }, this.options.tripOptions);
    this.emit({ type: 'trip', session: this.trip.session });
    this.emitLocationNeeds();
    return true;
  }

  // ---- location ------------------------------------------------------------------------------

  /** Feed every location fix from the OS here. */
  async onLocationFix(fix: LocationFix): Promise<void> {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return;
    if (!Number.isFinite(fix.timestamp)) return;
    if (this.lastFix && fix.timestamp < this.lastFix.timestamp) return; // out of order
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
    for (const body of this.trip.onFix(fix)) await this.broadcastTrip(body);
    if (this.trip.isEnded) this.afterTripEnded();
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
    for (const s of ending) await this.sendTo(s.contactKey, { type: 'live.end', shareId: s.shareId, reason }, TTL.live);
    this.emitLocationNeeds();
  }

  private async sendLiveUpdates(fix: LocationFix): Promise<void> {
    if (this.state.ghost || !this.state.liveShares.length) return;
    const now = this.now();
    const active = this.state.liveShares.filter((s) => !s.expiresAt || now < s.expiresAt);
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

  /** "Gut angekommen", "Alles okay", "Bin zuhause". Also ends my running watches. */
  async sendCheckin(input: { to: ContactKey[]; kind: CheckinKind; text?: string; placeName?: string }): Promise<void> {
    const to = [...new Set(input.to)].filter((k) => this.contact(k));
    if (!to.length) throw new RangeError('Wähle mindestens einen Kontakt.');
    const text = input.text?.trim() ? cleanText(input.text, 140) : undefined;
    const placeName = input.placeName?.trim() ? cleanText(input.placeName, 60) : this.currentPlace()?.name;
    const id = await this.sendMany(to, { type: 'checkin', kind: input.kind, text, placeName }, TTL.chat);
    for (const k of to) this.recordSent(k, `${id.slice(0, 40)}-${k.slice(0, 8)}`, checkinText(input.kind, text, placeName), 'ping');
    if (input.kind !== 'custom') {
      for (const w of [...this.state.watches]) await this.endWatch(w.watchId, 'ok');
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
    const label = cleanText(input.label || 'Unterwegs', 60);
    const watchId = randomId();
    this.update({
      watches: [...this.state.watches, { watchId, recipients: to, label, dueAt: input.dueAt, startedAt: now, tripId: input.tripId }].slice(-20),
    });
    await this.sendMany(to, { type: 'watch.start', watchId, label, dueAt: input.dueAt }, watchTtl(input.dueAt, now));
    this.scheduleOwnWatchAlarms(watchId);
    return watchId;
  }

  /** Moves the deadline of one of my watches. */
  async extendWatch(watchId: string, dueAt: number): Promise<void> {
    const w = this.state.watches.find((x) => x.watchId === watchId);
    if (!w) return;
    const now = this.now();
    checkWatchTime(dueAt, now);
    this.update({ watches: this.state.watches.map((x) => (x.watchId === watchId ? { ...x, dueAt } : x)) });
    await this.sendMany(w.recipients, { type: 'watch.start', watchId, label: w.label, dueAt }, watchTtl(dueAt, now));
    this.scheduleOwnWatchAlarms(watchId);
  }

  async endWatch(watchId: string, reason: 'ok' | 'cancelled'): Promise<void> {
    const w = this.state.watches.find((x) => x.watchId === watchId);
    if (!w) return;
    this.update({ watches: this.state.watches.filter((x) => x.watchId !== watchId) });
    this.emit({ type: 'alarm.cancel', id: `mywatch:${watchId}:remind` });
    this.emit({ type: 'alarm.cancel', id: `mywatch:${watchId}:due` });
    await this.sendMany(w.recipients, { type: 'watch.end', watchId, reason }, TTL.chat);
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
    const chosen = input.recipients?.length ? input.recipients : this.emergencyContacts().map((c) => c.key);
    const existing = this.state.sos;
    const all = [...new Set([...(existing?.recipients ?? []), ...chosen])].filter((k) => this.contact(k)).slice(0, 21);
    if (!all.length) throw new RangeError('Lege zuerst Notfallkontakte fest.');
    const text = (input.text?.trim() || existing?.text || this.state.sosMessage)?.slice(0, 200) || undefined;
    const sosId = existing?.sosId ?? randomId();
    this.update({
      sos: { sosId, startedAt: existing?.startedAt ?? now, recipients: all, text, locationUntil: now + SOS_LOCATION_MS, acks: existing?.acks ?? [] },
    });
    this.sosTracker.reset();
    const fix = this.freshFix();
    if (fix) this.sosTracker.precise(fix);
    const point = fix ? toPoint(fix) : undefined;
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
    if (!sos || this.now() >= sos.locationUntil) return;
    const point = this.sosTracker.precise(fix);
    if (point) await this.sendMany(sos.recipients, { type: 'sos.update', sosId: sos.sosId, point }, TTL.sos);
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
    if (this.state.groups.length >= MAX_GROUPS) throw new RangeError('Du hast schon sehr viele Gruppen.');
    const group: Group = {
      id: randomId(),
      name: cleanText(name, 40),
      owner: this.state.self.key,
      members: this.rosterFor(memberKeys),
      version: 1,
      updatedAt: this.now(),
    };
    this.update({ groups: [...this.state.groups, group] });
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
    await this.broadcastRoster(next, removed);
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

  private async broadcastRoster(g: Group, removed: ContactKey[]): Promise<void> {
    const to = [...g.members.map((m) => m.key), ...removed].filter((k) => k !== this.state.self.key);
    await this.sendMany(to, rosterBody(g), TTL.chat, true);
  }

  // ---- my other devices -----------------------------------------------------------------------

  /** Checks a scanned device code and returns the 6-digit code both screens must show. */
  previewLink(text: string): { ok: true; code: string } | { ok: false; error: string } {
    const d = decodeLinkInvite(text, this.now());
    return d.ok ? { ok: true, code: linkCode(d.invite) } : d;
  }

  /**
   * Sends my account to a new device that shows a device code. The identity key travels
   * end-to-end encrypted to the new device's one-time key; only that device can read it.
   */
  async sendLink(text: string, secretKeyHex: string): Promise<void> {
    const d = decodeLinkInvite(text, this.now());
    if (!d.ok) throw new Error(d.error);
    if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) throw new Error('Ungültiger Schlüssel.');
    const { self } = this.state;
    const payload = {
      format: 'heyda.link',
      v: 1,
      nonce: d.invite.nonce,
      secretKey: secretKeyHex,
      relays: self.relays,
      deviceId: self.deviceId,
      deviceName: self.deviceName,
      devices: this.state.devices,
      doc: buildSyncDoc(this.state),
    };
    for (const chunk of chunkPayload(randomId(), 'link', payload)) {
      await this.transport.send(d.invite.tempKey, composeMessage(chunk, this.now()), { ttlSeconds: TTL.link, relays: d.invite.relays });
    }
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
    if (this.trip && !this.trip.isEnded) {
      const end = this.trip.expire(now);
      if (end.length) {
        for (const body of end) await this.broadcastTrip(body);
        this.afterTripEnded();
      }
    }
    for (const s of this.state.liveShares.filter((x) => x.expiresAt !== undefined && now >= x.expiresAt)) {
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
    this.checkOverdueWatches(now);
    this.pruneStatuses(now);
    this.pruneLists(now);
    this.emitLocationNeeds();
    await this.flushOutbox();
    await this.flushSync();
  }

  /** Tries to send everything that failed earlier (e.g. while offline). */
  async flushOutbox(force = false): Promise<void> {
    if (this.flushingOutbox || !this.state.outbox.length) return;
    this.flushingOutbox = true;
    try {
      const before = new Set(this.state.outbox);
      const now = this.now();
      const keep: OutboxEntry[] = [];
      let offline = false;
      for (const e of before) {
        if (now > e.firstAt + e.ttlSeconds * 1000) continue;
        if (offline || (!force && (e.nextAt ?? 0) > now)) {
          keep.push(e);
          continue;
        }
        try {
          await this.transport.send(e.to, e.message, { ttlSeconds: e.ttlSeconds });
        } catch {
          offline = true;
          const attempts = e.attempts + 1;
          keep.push({ ...e, attempts, nextAt: now + Math.min(10 * 60_000, 15_000 * 2 ** Math.min(attempts, 6)) });
        }
      }
      // Entries queued while this loop was sending stay too.
      const added = this.state.outbox.filter((e) => !before.has(e));
      this.update({ outbox: [...keep, ...added].slice(-MAX_OUTBOX) });
    } finally {
      this.flushingOutbox = false;
    }
  }

  // ---- incoming --------------------------------------------------------------------------------

  private async handleIncoming({ from, message }: IncomingMessage): Promise<void> {
    if (!this.seen.add(`${from}|${message.id}`)) return;

    if (from === this.state.self.key) {
      this.handleOwn(message);
      return;
    }
    if (message.type === 'hello') {
      this.handleHello(from, message);
      return;
    }
    // Only contacts can reach this device. Group members who are not my contacts may
    // write in a group whose owner is a contact of mine (the owner vouched for them).
    if (!this.contact(from)) {
      if (message.type === 'group.text' || message.type === 'group.leave') {
        if (!this.isMember(message.groupId, from)) return;
      } else if (message.type === 'group.update') {
        if (this.group(message.groupId)?.owner !== from) return;
      } else {
        return;
      }
    }

    const at = this.now();
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
        const urgent = message.urgent === true && this.urgentLimiter.allow(from, at);
        this.emit({ type: 'chat', thread: from, entry: { id: message.id, from, text: message.text, at, kind: 'text', urgent: urgent || undefined } });
        this.alert({ category: 'chat', title: this.name(from), body: message.text, from, thread: from, urgent });
        await this.runAutomations({ type: 'contact.message', contact: from, text: message.text, at });
        return;
      }
      case 'ping': {
        const urgent = message.urgent === true && this.urgentLimiter.allow(from, at);
        const text = pingText(message.kind, message.text);
        this.emit({ type: 'chat', thread: from, entry: { id: message.id, from, text, at, kind: 'ping', urgent: urgent || undefined } });
        this.alert({ category: 'ping', title: this.name(from), body: text, from, thread: from, urgent });
        await this.runAutomations({ type: 'contact.ping', contact: from, kind: message.kind, text: message.text, at });
        return;
      }
      case 'group.update':
        return this.onGroupUpdate(from, message);
      case 'group.text':
        return this.onGroupText(from, message, at);
      case 'group.leave':
        return this.onGroupLeave(from, message);
      default:
        // sync.sent, link.done and xfer.chunk only count from my own devices.
        return;
    }
  }

  private handleHello(from: ContactKey, message: MessageOf<'hello'>): void {
    const existing = this.contact(from);
    if (existing) {
      if (existing.name !== message.name || JSON.stringify(existing.relays) !== JSON.stringify(message.relays)) {
        this.editContact(from, { name: message.name, relays: message.relays });
      }
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
    const p = raw as { format?: unknown; v?: unknown; deviceId?: unknown; deviceName?: unknown; doc?: unknown };
    if (p.format !== 'heyda.sync' || p.v !== 1 || typeof p.deviceId !== 'string') return;
    if (p.deviceId === this.state.self.deviceId || !/^[A-Za-z0-9_-]{8,32}$/.test(p.deviceId)) return;
    const doc = parseSyncDoc(p.doc);
    if (!doc) return;
    const deviceName = typeof p.deviceName === 'string' ? p.deviceName.trim().slice(0, 40) : '';
    this.upsertDevice(p.deviceId, deviceName || 'Gerät');
    const patch = mergeSyncDoc(this.state, doc, this.now());
    if (patch.places) this.geofence.setPlaces(patch.places);
    if (patch.contacts) {
      for (const key of [...this.statuses.keys()]) if (!patch.contacts.some((c) => c.key === key)) this.statuses.delete(key);
    }
    if (Object.keys(patch).length) this.update(patch);
    // If I know something the other device does not, answer with my version.
    const mine = buildSyncDoc(this.state);
    const theirsOlder =
      (Object.keys(mine.rev) as SyncField[]).some((f) => (mine.rev[f] ?? 0) > (doc.rev[f] ?? 0)) ||
      JSON.stringify(mine.contacts) !== JSON.stringify(doc.contacts) ||
      JSON.stringify(mine.groups) !== JSON.stringify(doc.groups);
    if (theirsOlder) this.markSync();
  }

  private upsertDevice(deviceId: string, name: string): void {
    const existing = this.state.devices.find((d) => d.deviceId === deviceId);
    if (existing && existing.name === name) return;
    const device: LinkedDevice = { deviceId, name, linkedAt: existing?.linkedAt ?? this.now() };
    this.update({ devices: [...this.state.devices.filter((d) => d.deviceId !== deviceId), device].slice(-20) });
  }

  private onPresence(from: ContactKey, m: MessageOf<'presence'>, at: number): void {
    const prev = this.statuses.get(from)?.presence;
    if (prev?.sentAt !== undefined && m.sentAt < prev.sentAt) return;
    const presence: NonNullable<ContactStatus['presence']> = { updatedAt: at, sentAt: m.sentAt };
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
    this.setStatus(from, {
      trip: {
        ...(same ? prev : {}),
        sessionId: m.sessionId,
        destinationName: m.destinationName,
        level: m.level,
        expiresAt: Math.min(m.expiresAt, at + DAY),
        updatedAt: at,
        lastSentAt: same ? prev.lastSentAt : m.sentAt,
      },
    });
    if (same) return;
    this.alert({ category: 'trip', title: `${this.name(from)} ist unterwegs`, body: `nach ${m.destinationName}`, from, thread: from });
    await this.runAutomations({ type: 'contact.trip_start', contact: from, sessionId: m.sessionId, destinationName: m.destinationName, at });
  }

  private async onTripUpdate(from: ContactKey, m: MessageOf<'session.update'>, at: number): Promise<void> {
    if (this.ended.has(`trip|${from}|${m.sessionId}`)) return;
    const prev = this.statuses.get(from)?.trip;
    if (prev && prev.sessionId === m.sessionId && m.sentAt < prev.lastSentAt) return; // relays may reorder
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
      lastSentAt: m.sentAt,
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
    this.setStatus(from, { lastPlace: { kind: m.kind, placeName: m.placeName, at } });
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
          lastSentAt: same ? prev.lastSentAt : m.sentAt,
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
    if (same && m.sentAt < prev.lastSentAt) return;
    // Updates that overtake their start message are kept as coarse until the start arrives.
    const base = same ? prev : { shareId: m.shareId, level: 'coarse' as const };
    const point = base.level === 'precise' ? m.point : undefined;
    if (!point && !m.cell) return;
    this.setStatus(from, {
      live: { ...base, ...(point ? { point } : {}), ...(m.cell ? { cell: m.cell } : {}), updatedAt: at, lastSentAt: m.sentAt },
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
    if (m.dueAt <= at - HOUR || m.dueAt > at + MAX_WATCH_MS + HOUR) return;
    const watches = this.statuses.get(from)?.watches ?? [];
    const existing = watches.find((w) => w.watchId === m.watchId);
    if (existing && existing.dueAt === m.dueAt && existing.label === m.label) return;
    if (!existing && watches.length >= MAX_WATCHES_PER_CONTACT) return;
    const next = { watchId: m.watchId, label: m.label, dueAt: m.dueAt, startedAt: existing?.startedAt ?? at };
    this.setStatus(from, { watches: [...watches.filter((w) => w.watchId !== m.watchId), next] });
    const c = this.contact(from);
    const dndThen = isDndActive(this.state.prefs.dnd, m.dueAt, this.localTime);
    this.emit({
      type: 'alarm.schedule',
      alarm: {
        id: `watch:${from}:${m.watchId}`,
        at: m.dueAt,
        title: `⏰ ${this.name(from)} hat sich nicht gemeldet`,
        body: `„${m.label}“ war bis ${this.hhmm(m.dueAt)} geplant. Frag nach, ob alles okay ist.`,
        level: alertLevel({ category: 'watch', favorite: c?.favorite, muted: c?.muted }, this.state.prefs, dndThen),
      },
    });
    this.alert({
      category: 'trip',
      title: existing ? `${this.name(from)} hat die Zeit geändert` : `${this.name(from)}: Pass auf mich auf`,
      body: `„${m.label}“, meldet sich bis ${this.hhmm(m.dueAt)}`,
      from,
      thread: from,
      ref: { watchId: m.watchId },
    });
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
      if (!status.watches?.some((w) => !w.firedAt && now >= w.dueAt)) continue;
      const watches = status.watches.map((w) => {
        if (w.firedAt || now < w.dueAt) return w;
        // Same id as the scheduled alarm, so the platform shows one notification, not two.
        this.alert({
          id: `watch:${key}:${w.watchId}`,
          category: 'watch',
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
      if (this.ended.has(`sos|${from}|${m.sosId}`)) return;
      this.setStatus(from, {
        sos: {
          sosId: m.sosId,
          startedAt: same ? prev.startedAt : at,
          text: m.text,
          point: m.point ?? (same ? prev.point : undefined),
          pointAt: m.point ? at : same ? prev.pointAt : undefined,
          others: m.others.filter((o) => o.key !== this.state.self.key && o.key !== from),
          acks: same ? prev.acks : [],
          lastSentAt: m.sentAt,
        },
      });
      if (same) return;
      // An SOS always rings. Only a flood of them from one person is turned down to a normal notification.
      const alarm = this.sosAlarmLimiter.allow(from, at);
      this.alert({
        id: `sos:${from}:${m.sosId}`,
        category: alarm ? 'sos' : 'chat',
        title: `🆘 ${this.name(from)} braucht Hilfe!`,
        body: m.text ?? (m.point ? 'Der Standort ist dabei. Tippe, um ihn zu sehen.' : 'Bitte melde dich sofort.'),
        from,
        thread: from,
        ref: { sosId: m.sosId, sosOwner: from },
      });
      await this.runAutomations({ type: 'contact.sos', contact: from, at });
      return;
    }
    if (m.type === 'sos.update') {
      if (!same || prev.endedAt) return;
      let next = prev;
      if (m.point && m.sentAt >= (prev.lastSentAt ?? 0)) next = { ...next, point: m.point, pointAt: at, lastSentAt: m.sentAt };
      if (m.acks) {
        const acks = [...next.acks];
        for (const a of m.acks) {
          if (a.key === this.state.self.key || acks.some((x) => x.key === a.key)) continue;
          acks.push({ key: a.key, name: this.contact(a.key) ? this.name(a.key) : a.name, at, text: a.text });
          this.alert({ category: 'checkin', title: `${a.name} kümmert sich um ${this.name(from)}`, body: a.text ?? 'Hilfe ist unterwegs.', from, thread: from, ref: { sosId: m.sosId, sosOwner: from } });
        }
        next = { ...next, acks };
      }
      if (next !== prev) this.setStatus(from, { sos: next });
      return;
    }
    this.ended.add(`sos|${from}|${m.sosId}`);
    if (!same || prev.endedAt) return;
    this.setStatus(from, { sos: { ...prev, endedAt: at, endReason: m.reason } });
    this.alert({
      category: 'checkin',
      title: m.reason === 'safe' ? `✅ ${this.name(from)} ist in Sicherheit` : `${this.name(from)} hat den Notruf abgebrochen`,
      body: m.reason === 'safe' ? 'Der Notruf ist beendet.' : 'Es war wohl ein Versehen.',
      from,
      thread: from,
      ref: { sosId: m.sosId, sosOwner: from },
    });
  }

  private onSosAck(from: ContactKey, m: MessageOf<'sos.ack'>, at: number): void {
    const name = this.name(from);
    if (m.owner === this.state.self.key) {
      const sos = this.state.sos;
      if (!sos || sos.sosId !== m.sosId || !sos.recipients.includes(from)) return;
      const first = !sos.acks.some((a) => a.key === from);
      const acks = [...sos.acks.filter((a) => a.key !== from), { key: from, at, text: m.text }];
      this.update({ sos: { ...sos, acks } });
      this.alert({ category: 'checkin', title: `${name} kümmert sich`, body: m.text ?? 'Hilfe ist unterwegs.', from, thread: from, ref: { sosId: m.sosId, sosOwner: this.state.self.key } });
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
      category: 'checkin',
      title: `${name} kümmert sich um ${this.name(m.owner)}`,
      body: m.text ?? 'Hilfe ist unterwegs.',
      from,
      thread: m.owner,
      ref: { sosId: m.sosId, sosOwner: m.owner },
    });
  }

  private onWhereRequest(from: ContactKey, m: MessageOf<'where.request'>, at: number): void {
    if (!this.whereLimiter.allow(from, at)) return;
    this.update({
      whereInbox: [...this.state.whereInbox.filter((w) => w.from !== from && at - w.at < DAY), { from, requestId: m.requestId, at }].slice(-50),
    });
    this.emit({ type: 'chat', thread: from, entry: { id: m.id, from, text: '📍 Wo bist du?', at, kind: 'ping' } });
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

  private onGroupUpdate(from: ContactKey, m: MessageOf<'group.update'>): void {
    if (m.owner !== from) return;
    const g = this.group(m.groupId);
    if (g && (g.owner !== from || m.version <= g.version)) return;
    const meIn = m.members.some((x) => x.key === this.state.self.key);
    if (!g) {
      if (this.state.leftGroups.some((x) => x.id === m.groupId)) return;
      if (!meIn || m.dissolved || !this.contact(from) || this.state.groups.length >= MAX_GROUPS) return;
    }
    if (!meIn || m.dissolved) {
      this.update({
        groups: this.state.groups.filter((x) => x.id !== m.groupId),
        leftGroups: [...this.state.leftGroups.filter((x) => x.id !== m.groupId), { id: m.groupId, at: this.now() }].slice(-200),
      });
      this.markSync();
      this.alert({
        category: 'group',
        title: m.name,
        body: m.dissolved ? 'Die Gruppe wurde aufgelöst.' : 'Du bist nicht mehr in dieser Gruppe.',
        from,
        ref: { groupId: m.groupId },
      });
      return;
    }
    const next: Group = { id: m.groupId, name: m.name, owner: m.owner, members: m.members, version: m.version, updatedAt: this.now() };
    this.update({ groups: g ? this.state.groups.map((x) => (x.id === m.groupId ? next : x)) : [...this.state.groups, next] });
    this.markSync();
    if (!g) {
      this.alert({
        category: 'group',
        title: m.name,
        body: `${this.name(from)} hat dich zur Gruppe hinzugefügt.`,
        from,
        thread: `g:${m.groupId}`,
        ref: { groupId: m.groupId },
      });
    }
  }

  private onGroupText(from: ContactKey, m: MessageOf<'group.text'>, at: number): void {
    const g = this.group(m.groupId);
    if (!g || g.dissolved || !this.isMember(m.groupId, from)) return;
    const urgent = m.urgent === true && this.urgentLimiter.allow(from, at);
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
    for (const intent of this.engine.handle(event)) {
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
            await this.sendCheckin({ to: intent.to, kind: intent.checkinKind, text: intent.text });
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

  private afterTripEnded(): void {
    const trip = this.trip;
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

  private async deliver(to: ContactKey, message: AppMessage, ttlSeconds: number): Promise<void> {
    try {
      await this.transport.send(to, message, { ttlSeconds });
    } catch {
      const now = this.now();
      this.enqueue({ to, message, ttlSeconds, firstAt: now, attempts: 1, nextAt: now + 15_000 });
    }
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

  private alert(input: Omit<Alert, 'id' | 'at' | 'level'> & { id?: string; urgent?: boolean }): void {
    const now = this.now();
    const { urgent, id, ...rest } = input;
    const c = input.from ? this.contact(input.from) : undefined;
    let level: AlertLevel = alertLevel(
      { category: input.category, favorite: c?.favorite, muted: c?.muted, urgent },
      this.state.prefs,
      this.dndActive(),
    );
    const critical = input.category === 'sos' || input.category === 'watch';
    if (!critical && input.from && level !== 'feed' && !this.alertLimiter.allow(input.from, now)) level = 'feed';
    this.emit({ type: 'alert', alert: { ...rest, id: id ?? randomId(), at: now, level } });
  }

  private addContact(input: { key: ContactKey; name: string; relays: string[] }): Contact {
    const existing = this.contact(input.key);
    if (existing) return existing;
    if (this.state.contacts.length >= MAX_CONTACTS) throw new RangeError('Du hast die maximale Anzahl an Kontakten erreicht.');
    const now = this.now();
    const contact: Contact = { ...input, addedAt: now, verified: false, updatedAt: now };
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
    this.update({ contacts: this.state.contacts.map((c) => (c.key === key ? stripUndefined({ ...c, ...patch, updatedAt: now }) : c)) });
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
    return this.group(groupId)?.members.some((m) => m.key === key) ?? false;
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
      if (s.sos && ((s.sos.endedAt !== undefined && now - s.sos.endedAt > DAY) || now - s.sos.startedAt > 3 * DAY)) patch.sos = undefined;
      if (s.watches?.some((w) => now > w.dueAt + 12 * HOUR)) patch.watches = s.watches.filter((w) => now <= w.dueAt + 12 * HOUR);
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
    let next: NodeState = { ...this.state, ...patch };
    if (syncFields.length) {
      const rev = { ...next.syncRev };
      for (const f of syncFields) rev[f] = Math.max(this.now(), (rev[f] ?? 0) + 1);
      next = { ...next, syncRev: rev };
    }
    this.state = next;
    this.emit({ type: 'state', state: this.state });
    if (syncFields.length) this.markSync();
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
    members: g.members.map((m) => ({ key: m.key, name: m.name, ...(m.relays?.length ? { relays: m.relays.slice(0, 8) } : {}) })),
    version: g.version,
  };
}

function replaceKey(e: OutboxEntry): string {
  const m = e.message as { type: string; sessionId?: string; shareId?: string; sosId?: string };
  const acksOnly = m.type === 'sos.update' && !(e.message as { point?: unknown }).point ? '|acks' : '';
  return `${e.to}|${m.type}|${m.sessionId ?? m.shareId ?? m.sosId ?? ''}${acksOnly}`;
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

function checkWatchTime(dueAt: number, now: number): void {
  if (!Number.isFinite(dueAt) || dueAt < now + MIN_WATCH_MS || dueAt > now + MAX_WATCH_MS) {
    throw new RangeError('Die Zeit muss zwischen 5 Minuten und 48 Stunden in der Zukunft liegen.');
  }
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
