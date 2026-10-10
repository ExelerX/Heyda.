import { AutomationEngine, type ActionIntent, type AutomationEvent, type LocalTime } from './automation/engine';
import type { Rule } from './automation/schema';
import { GeofenceTracker, type Place } from './geo/geofence';
import type { LatLon, LocationFix } from './geo/types';
import { decodeInvite, encodeInvite, InviteBook } from './pairing/invite';
import { PrivacyPolicy, type PlaceGrant } from './privacy/policy';
import { composeMessage } from './protocol/compose';
import type { AppMessage, AppMessageBody, MessageOf } from './protocol/messages';
import { createSession, type SessionLevel, type SharingSession } from './session/session';
import { TripSharer, type TripOptions } from './session/trip';
import type { ContactKey, IncomingMessage, Transport } from './transport/transport';

export interface Contact {
  key: ContactKey;
  name: string;
  relays: string[];
  addedAt: number;
  /** Set once both people compared the safety number in person. */
  verified: boolean;
}

export interface NodeState {
  self: { key: ContactKey; name: string; relays: string[] };
  contacts: Contact[];
  places: Place[];
  grants: PlaceGrant[];
  rules: Rule[];
  ghost: boolean;
}

/** What a contact currently shares with me, for the home screen. */
export interface ContactStatus {
  trip?: {
    sessionId: string;
    destinationName: string;
    level: SessionLevel;
    expiresAt: number;
    etaMinutes?: number;
    cell?: { lat: number; lon: number; cellM: number };
    point?: { lat: number; lon: number; accuracyM: number };
    updatedAt: number;
    lastSentAt: number;
  };
  lastPlace?: { kind: 'arrive' | 'leave'; placeName: string; at: number };
}

export type NodeEvent =
  | { type: 'contact.added'; contact: Contact }
  | { type: 'message'; from: ContactKey; message: AppMessage }
  | { type: 'status'; contact: ContactKey; status: ContactStatus }
  | { type: 'notify'; intent: Extract<ActionIntent, { kind: 'notify' }> }
  | { type: 'trip'; session: SharingSession | undefined }
  | { type: 'state'; state: NodeState };

export interface SocialNodeOptions {
  transport: Transport;
  initialState: NodeState;
  now?: () => number;
  localTime?: (now: number) => LocalTime;
  tripOptions?: TripOptions;
}

/** Trip events and chat may wait on a relay for an offline phone this long. */
const TTL = { trip: 6 * 3600, chat: 7 * 24 * 3600, place: 24 * 3600 } as const;

/**
 * Wires transport, privacy policy, geofences, trips and automations together.
 * The UI talks only to this class; it holds no platform code, so it runs the same
 * in tests, in the demo mode and on a phone.
 */
export class SocialNode {
  private state: NodeState;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly policy: PrivacyPolicy;
  private readonly geofence: GeofenceTracker;
  private readonly engine: AutomationEngine;
  private readonly invites = new InviteBook();
  private readonly listeners = new Set<(e: NodeEvent) => void>();
  private readonly statuses = new Map<ContactKey, ContactStatus>();
  private trip: TripSharer | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: SocialNodeOptions) {
    this.state = structuredCloneState(options.initialState);
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.policy = new PrivacyPolicy(() => this.state);
    this.geofence = new GeofenceTracker(this.state.places);
    this.engine = new AutomationEngine({
      rules: () => this.state.rules,
      contactName: (k) => this.contact(k)?.name ?? 'Unbekannt',
      placeName: (id) => this.state.places.find((p) => p.id === id)?.name,
      isAtPlace: (id) => this.geofence.isInside(id),
      localTime: options.localTime,
    });
  }

  // ---- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    this.unsubscribe = this.transport.onMessage((m) => void this.handleIncoming(m));
    await this.transport.start();
  }

  async stop(): Promise<void> {
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

  get activeTrip(): SharingSession | undefined {
    return this.trip && !this.trip.isEnded ? this.trip.session : undefined;
  }

  // ---- state edits ---------------------------------------------------------------

  setGhost(ghost: boolean): void {
    this.update({ ghost });
  }

  setPlaces(places: Place[]): void {
    this.geofence.setPlaces(places);
    this.update({ places });
  }

  setGrants(grants: PlaceGrant[]): void {
    this.update({ grants });
  }

  setRules(rules: Rule[]): void {
    this.update({ rules });
  }

  markVerified(key: ContactKey): void {
    this.update({ contacts: this.state.contacts.map((c) => (c.key === key ? { ...c, verified: true } : c)) });
  }

  removeContact(key: ContactKey): void {
    this.statuses.delete(key);
    this.update({
      contacts: this.state.contacts.filter((c) => c.key !== key),
      grants: this.state.grants.filter((g) => g.contactKey !== key),
    });
  }

  // ---- pairing ----------------------------------------------------------------------

  /** Text for the QR code this phone shows. */
  createInvite(): string {
    return encodeInvite(this.invites.create(this.state.self, this.now()));
  }

  /** Called with the text of a scanned QR code. */
  async acceptInvite(text: string): Promise<Contact> {
    const decoded = decodeInvite(text, this.now());
    if (!decoded.ok) throw new Error(decoded.error);
    const { invite } = decoded;
    if (invite.key === this.state.self.key) throw new Error('Das ist dein eigener Code');
    const contact = this.addContact({ key: invite.key, name: invite.name, relays: invite.relays });
    await this.sendTo(
      contact.key,
      { type: 'hello', name: this.state.self.name, relays: this.state.self.relays, inviteNonce: invite.nonce },
      TTL.chat,
    );
    return contact;
  }

  // ---- trips ------------------------------------------------------------------------

  async startTrip(input: {
    recipients: ContactKey[];
    destinationName: string;
    destination?: LatLon;
    level?: SessionLevel;
    durationMs?: number;
  }): Promise<SharingSession> {
    if (this.activeTrip) await this.stopTrip();
    const known = input.recipients.filter((k) => this.contact(k));
    const session = createSession({ ...input, recipients: known, now: this.now() });
    this.trip = new TripSharer(session, this.options.tripOptions);
    await this.broadcastTrip(this.trip.startMessage());
    this.emit({ type: 'trip', session });
    return session;
  }

  async stopTrip(): Promise<void> {
    if (!this.trip || this.trip.isEnded) return;
    await this.broadcastTrip(this.trip.stopMessage());
    this.emit({ type: 'trip', session: undefined });
  }

  /** Feed every location fix from the OS here. */
  async onLocationFix(fix: LocationFix): Promise<void> {
    for (const ev of this.geofence.update(fix)) {
      const place = this.state.places.find((p) => p.id === ev.placeId);
      if (!place) continue;
      for (const to of this.policy.placeEventRecipients(place.id, this.now())) {
        await this.sendTo(to, { type: 'place.event', kind: ev.type, placeName: place.name }, TTL.place);
      }
      await this.runAutomations({ type: ev.type === 'arrive' ? 'me.arrive' : 'me.leave', placeId: place.id, at: ev.at });
    }

    if (this.trip && !this.trip.isEnded) {
      for (const body of this.trip.onFix(fix)) await this.broadcastTrip(body);
      if (this.trip.isEnded) this.emit({ type: 'trip', session: undefined });
    }
  }

  // ---- chat -------------------------------------------------------------------------

  async sendChat(to: ContactKey, text: string): Promise<void> {
    await this.sendTo(to, { type: 'chat.text', text }, TTL.chat);
  }

  async sendPing(to: ContactKey, kind: 'help-carry' | 'pickup-request' | 'custom', text?: string): Promise<void> {
    await this.sendTo(to, { type: 'ping', kind, text }, TTL.chat);
  }

  // ---- internals ----------------------------------------------------------------------

  private async broadcastTrip(body: AppMessageBody): Promise<void> {
    const session = this.trip?.session;
    if (!session) return;
    for (const to of session.recipients) {
      const allowed =
        body.type === 'session.update'
          ? this.policy.canSendSessionUpdate(to, session, body, this.now())
          : this.policy.canSendSessionLifecycle(to, session);
      if (allowed) await this.sendTo(to, body, TTL.trip);
    }
  }

  private async sendTo(to: ContactKey, body: AppMessageBody, ttlSeconds: number): Promise<void> {
    if (!this.contact(to)) return;
    await this.transport.send(to, composeMessage(body, this.now()), { ttlSeconds });
  }

  private async handleIncoming({ from, message }: IncomingMessage): Promise<void> {
    if (message.type === 'hello') {
      await this.handleHello(from, message);
      return;
    }
    // Only people added in person can reach this phone. Everything else is dropped silently.
    if (!this.contact(from)) return;
    this.emit({ type: 'message', from, message });

    const at = this.now();
    switch (message.type) {
      case 'session.start': {
        const prev = this.statuses.get(from)?.trip;
        const trip = {
          ...(prev?.sessionId === message.sessionId ? prev : {}),
          sessionId: message.sessionId,
          destinationName: message.destinationName,
          level: message.level,
          expiresAt: message.expiresAt,
          updatedAt: at,
          lastSentAt: prev?.sessionId === message.sessionId ? prev.lastSentAt : message.sentAt,
        };
        this.setStatus(from, { trip });
        await this.runAutomations({
          type: 'contact.trip_start',
          contact: from,
          sessionId: message.sessionId,
          destinationName: message.destinationName,
          at,
        });
        break;
      }
      case 'session.update':
        await this.applyTripUpdate(from, message, at);
        break;
      case 'session.end': {
        const current = this.statuses.get(from)?.trip;
        if (current?.sessionId === message.sessionId) this.setStatus(from, { trip: undefined });
        await this.runAutomations({
          type: 'contact.trip_end',
          contact: from,
          sessionId: message.sessionId,
          reason: message.reason,
          at,
        });
        break;
      }
      case 'place.event':
        this.setStatus(from, { lastPlace: { kind: message.kind, placeName: message.placeName, at } });
        await this.runAutomations({
          type: message.kind === 'arrive' ? 'contact.arrive' : 'contact.leave',
          contact: from,
          placeName: message.placeName,
          at,
        });
        break;
      case 'chat.text':
        await this.runAutomations({ type: 'contact.message', contact: from, text: message.text, at });
        break;
      case 'ping':
        await this.runAutomations({ type: 'contact.ping', contact: from, kind: message.kind, text: message.text, at });
        break;
    }
  }

  private async handleHello(from: ContactKey, message: MessageOf<'hello'>): Promise<void> {
    const existing = this.contact(from);
    if (existing) {
      // A known contact refreshing their name or relays.
      this.update({
        contacts: this.state.contacts.map((c) =>
          c.key === from ? { ...c, name: message.name, relays: message.relays } : c,
        ),
      });
      return;
    }
    // A stranger may only become a contact by answering a QR code this phone showed.
    if (!message.inviteNonce || !this.invites.consume(message.inviteNonce, this.now())) return;
    this.addContact({ key: from, name: message.name, relays: message.relays });
  }

  private async applyTripUpdate(from: ContactKey, m: MessageOf<'session.update'>, at: number): Promise<void> {
    const prev = this.statuses.get(from)?.trip;
    if (prev && prev.sessionId === m.sessionId && m.sentAt < prev.lastSentAt) return; // stale, relays may reorder
    const base =
      prev?.sessionId === m.sessionId
        ? prev
        : { sessionId: m.sessionId, destinationName: '…', level: 'eta' as const, expiresAt: at + 3600_000 };
    const trip = {
      ...base,
      ...(m.etaMinutes !== undefined ? { etaMinutes: m.etaMinutes } : {}),
      ...(m.cell ? { cell: m.cell } : {}),
      ...(m.point ? { point: m.point } : {}),
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

  private async runAutomations(event: AutomationEvent): Promise<void> {
    for (const intent of this.engine.handle(event)) {
      switch (intent.kind) {
        case 'notify':
          this.emit({ type: 'notify', intent });
          break;
        case 'send_ping':
          await this.sendPing(intent.to, intent.pingKind, intent.text);
          break;
        case 'start_trip': {
          const place = this.state.places.find((p) => p.id === intent.destination);
          if (!place || this.activeTrip) break;
          await this.startTrip({
            recipients: intent.to,
            destinationName: place.name,
            destination: place.center,
            level: intent.level,
          });
          break;
        }
      }
    }
  }

  private addContact(input: { key: ContactKey; name: string; relays: string[] }): Contact {
    const existing = this.contact(input.key);
    if (existing) return existing;
    const contact: Contact = { ...input, addedAt: this.now(), verified: false };
    this.update({ contacts: [...this.state.contacts, contact] });
    this.emit({ type: 'contact.added', contact });
    return contact;
  }

  private contact(key: ContactKey): Contact | undefined {
    return this.state.contacts.find((c) => c.key === key);
  }

  private setStatus(key: ContactKey, patch: Partial<ContactStatus>): void {
    const status = { ...this.statuses.get(key), ...patch };
    if ('trip' in patch && patch.trip === undefined) delete status.trip;
    this.statuses.set(key, status);
    this.emit({ type: 'status', contact: key, status });
  }

  private update(patch: Partial<NodeState>): void {
    this.state = { ...this.state, ...patch };
    this.emit({ type: 'state', state: this.state });
  }

  private emit(e: NodeEvent): void {
    for (const l of this.listeners) l(e);
  }
}

function structuredCloneState(s: NodeState): NodeState {
  return JSON.parse(JSON.stringify(s)) as NodeState;
}
