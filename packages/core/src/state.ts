import type { Rule } from './automation/schema';
import type { Place } from './geo/geofence';
import { DEFAULT_PREFS, normalizePrefs, type AlertCategory, type AlertLevel, type NotificationPrefs } from './notify/prefs';
import type { PlaceGrant } from './privacy/policy';
import type { AppMessage, Cell, CheckinKind, Point } from './protocol/messages';
import type { SessionLevel } from './session/session';
import type { ContactKey } from './transport/transport';

/** Someone I added in person. Fields marked "local" never leave my devices. */
export interface Contact {
  key: ContactKey;
  /** The name they chose. */
  name: string;
  relays: string[];
  addedAt: number;
  /** Set once both people compared the safety number in person. */
  verified: boolean;
  /** Local: what I call them. */
  nickname?: string;
  /** Local: comes through quiet mode. */
  favorite?: boolean;
  /** Local: no notifications (an SOS still rings). */
  muted?: boolean;
  /** Local: gets my SOS. */
  emergency?: boolean;
  /** Local: phone number for the SMS fallback of an SOS. */
  phone?: string;
  /** For syncing between my own devices. */
  updatedAt?: number;
}

export interface GroupMember {
  key: ContactKey;
  name: string;
  relays?: string[];
}

export interface Group {
  id: string;
  name: string;
  /** Only the owner can change the roster. */
  owner: ContactKey;
  members: GroupMember[];
  version: number;
  updatedAt: number;
  /**
   * Over for me: the owner took me off, or I left when I removed the owner as a contact. Kept
   * (hidden, with the owner alone as roster) for its version, so an older roster relays hand over
   * late cannot bring me back, while the owner adding me again can. Groups that were dissolved or
   * that I left myself go to `leftGroups` instead.
   */
  dissolved?: boolean;
}

/**
 * At most `max` groups, as many as my other devices take in a sync: hidden copies of groups I
 * was taken off (`Group.dissolved`) give way first, oldest first.
 */
export function capGroups(groups: Group[], max: number): Group[] {
  const over = groups.length - max;
  if (over <= 0) return groups;
  const drop = new Set(
    groups
      .filter((g) => g.dissolved)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, over),
  );
  return groups.filter((g) => !drop.has(g));
}

/** A standing "see my location" share with one contact. */
export interface LiveShare {
  shareId: string;
  contactKey: ContactKey;
  level: 'coarse' | 'precise';
  startedAt: number;
  /** Absent: until I turn it off. */
  expiresAt?: number;
}

export interface MySos {
  sosId: string;
  startedAt: number;
  recipients: ContactKey[];
  text?: string;
  /** Location updates stop after this, even if the alert is still open. */
  locationUntil: number;
  /** When my exact location last went out with this alert; absent = none sent yet (no fix). */
  pointSentAt?: number;
  acks: { key: ContactKey; at: number; text?: string }[];
}

export interface MyWatch {
  watchId: string;
  recipients: ContactKey[];
  label: string;
  dueAt: number;
  startedAt: number;
  /**
   * When it last started or moved, on this device or the one that told me (sender's clock), so
   * an older copy from another of my devices does not bring back an earlier deadline.
   */
  changedAt?: number;
  /** Ended automatically when this trip arrives (only on the device running the trip). */
  tripId?: string;
}

export interface MyStatus {
  text?: string;
  emoji?: string;
  expiresAt: number;
}

/** A phone runs what automations send to others; a computer (the Windows app) only when the account has no phone. */
export type DeviceKind = 'phone' | 'computer';

export interface LinkedDevice {
  deviceId: string;
  name: string;
  linkedAt: number;
  /** Unknown for a device that has not said yet (older version): it might be the phone. */
  kind?: DeviceKind;
}

export interface WhereRequest {
  from: ContactKey;
  requestId: string;
  at: number;
}

export interface OutboxEntry {
  to: ContactKey;
  message: AppMessage;
  ttlSeconds: number;
  firstAt: number;
  attempts: number;
  /** Earliest time for the next try. */
  nextAt?: number;
  /** Where to send it instead of the recipient's known relays (they may be gone from my contacts by then). */
  relays?: string[];
}

export interface NodeState {
  self: { key: ContactKey; name: string; relays: string[]; deviceId: string; deviceName: string };
  contacts: Contact[];
  places: Place[];
  grants: PlaceGrant[];
  rules: Rule[];
  ghost: boolean;
  groups: Group[];
  liveShares: LiveShare[];
  sos?: MySos;
  watches: MyWatch[];
  status?: MyStatus;
  prefs: NotificationPrefs;
  /** Default SOS text. */
  sosMessage?: string;
  devices: LinkedDevice[];
  /** Questions "where are you?" waiting for my answer. */
  whereInbox: WhereRequest[];
  /** Questions I asked, so only real answers are accepted. */
  whereAsked: WhereRequest[];
  /** QR invites I showed that were not answered yet. */
  openInvites: { nonce: string; expiresAt: number }[];
  /** Messages that could not be sent yet (offline), retried automatically. */
  outbox: OutboxEntry[];
  /** For syncing my own devices: when each part last changed, and removed contacts. */
  syncRev: Partial<Record<SyncField, number>>;
  removedContacts: { key: ContactKey; at: number }[];
  /** Groups I left, so a late roster update does not add me back. */
  leftGroups: { id: string; at: number }[];
  /**
   * Synced: the device that sends what automations send to others ("Automationen senden von").
   * Absent, or naming a device not in my list: the usual rule (see `SocialNode.runsAutomationActions`).
   */
  automationDevice?: string;
  /**
   * When this device got the account (linked or restored from a backup). Relays still hold the
   * days before: what the first catch-up hands over from before fills in chats and statuses but
   * rings and triggers nothing, since my other device (or the old phone) already handled it.
   * Cleared once that catch-up is in. Absent on a device that created the account.
   */
  historyBefore?: number;
}

export type SyncField = 'profile' | 'places' | 'grants' | 'rules' | 'prefs' | 'sosMessage' | 'status' | 'automationDevice';

/** What a contact currently shares with me. */
export interface ContactStatus {
  trip?: {
    sessionId: string;
    destinationName: string;
    level: SessionLevel;
    expiresAt: number;
    etaMinutes?: number;
    cell?: Cell;
    point?: Point;
    updatedAt: number;
    lastSentAt: number;
  };
  /** `sentAt`: the sender's clock, so an older event caught up late does not overwrite a newer one. */
  lastPlace?: { kind: 'arrive' | 'leave'; placeName: string; at: number; sentAt?: number };
  live?: {
    shareId: string;
    level: 'coarse' | 'precise';
    expiresAt?: number;
    cell?: Cell;
    point?: Point;
    updatedAt: number;
    lastSentAt: number;
  };
  presence?: {
    status?: { text?: string; emoji?: string; expiresAt: number };
    dnd?: { until?: number };
    updatedAt: number;
    /** Sender's clock, to drop updates that arrive out of order. */
    sentAt?: number;
  };
  sos?: {
    sosId: string;
    startedAt: number;
    text?: string;
    point?: Point;
    pointAt?: number;
    others: { key: ContactKey; name: string }[];
    acks: { key: ContactKey; name: string; at: number; text?: string }[];
    endedAt?: number;
    /** `removed`: they removed me as a contact, so no more updates come; the emergency may go on. */
    endReason?: 'safe' | 'cancelled' | 'removed';
    /** The sender's clock of the newest message of this alert, and of the newest start (sent again when pressed again). */
    lastSentAt?: number;
    startSentAt?: number;
    /** Sent before this device got the account: rings at this time if no end came by then. */
    ringAt?: number;
  };
  /**
   * `quiet`: this contact used up its hourly budget of loud alarms, so it rings as a normal notification.
   * `ringAt`: when the alarm rings, if later than `dueAt` (the watch arrived after its deadline).
   * `lastSentAt`: the sender's clock of the start or change I took, so an older copy is ignored.
   */
  watches?: {
    watchId: string;
    label: string;
    dueAt: number;
    startedAt: number;
    firedAt?: number;
    quiet?: boolean;
    ringAt?: number;
    lastSentAt?: number;
  }[];
  lastCheckin?: { kind: CheckinKind; text?: string; placeName?: string; at: number };
  lastWhere?: {
    requestId: string;
    answer: 'declined' | 'text' | 'place' | 'eta' | 'coarse' | 'precise';
    text?: string;
    placeName?: string;
    etaMinutes?: number;
    cell?: Cell;
    point?: Point;
    at: number;
  };
}

/** One line in a chat: a contact (thread = their key) or a group (thread = "g:" + id). */
export interface ChatEntry {
  id: string;
  from: 'me' | ContactKey;
  text: string;
  at: number;
  kind: 'text' | 'ping' | 'system';
  urgent?: boolean;
}

/** Something the user should know about. Every alert lands in the activity list. */
export interface Alert {
  id: string;
  at: number;
  category: AlertCategory;
  level: AlertLevel;
  title: string;
  body: string;
  from?: ContactKey;
  /** Where tapping it should lead. */
  thread?: string;
  /** `sosOwner` is whose emergency it is (my own key for helpers' replies to my SOS). */
  ref?: { sosId?: string; sosOwner?: ContactKey; watchId?: string; requestId?: string; groupId?: string };
}

/** A notification to fire at a fixed time, even if the app is not running then. */
export interface Alarm {
  id: string;
  at: number;
  title: string;
  body: string;
  level: AlertLevel;
}

/** Which kind of location tracking the platform should run right now. */
export interface LocationNeeds {
  /** off: none; low: coarse live sharing only; high: trip, precise live or SOS. */
  mode: 'off' | 'low' | 'high';
  reasons: ('trip' | 'live' | 'sos')[];
}

export function createInitialState(self: {
  key: ContactKey;
  name: string;
  relays: string[];
  deviceId: string;
  deviceName: string;
}): NodeState {
  return normalizeState({ self } as Partial<NodeState> & Pick<NodeState, 'self'>);
}

const DEVICE_ID = /^[A-Za-z0-9_-]{8,32}$/;

/** Fills in fields that older saved data may lack, so loading never crashes. */
export function normalizeState(s: Partial<NodeState> & Pick<NodeState, 'self'>): NodeState {
  const arr = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return {
    self: s.self,
    contacts: arr(s.contacts),
    places: arr(s.places),
    grants: arr(s.grants),
    rules: arr(s.rules),
    ghost: s.ghost === true,
    groups: arr(s.groups),
    liveShares: arr(s.liveShares),
    sos: s.sos,
    watches: arr(s.watches),
    status: s.status,
    prefs: normalizePrefs(s.prefs ?? DEFAULT_PREFS),
    sosMessage: s.sosMessage,
    devices: arr(s.devices),
    whereInbox: arr(s.whereInbox),
    whereAsked: arr(s.whereAsked),
    openInvites: arr(s.openInvites),
    outbox: arr(s.outbox),
    syncRev: s.syncRev ?? {},
    removedContacts: arr(s.removedContacts),
    leftGroups: arr(s.leftGroups),
    ...(typeof s.automationDevice === 'string' && DEVICE_ID.test(s.automationDevice) ? { automationDevice: s.automationDevice } : {}),
    ...(typeof s.historyBefore === 'number' && Number.isFinite(s.historyBefore) ? { historyBefore: s.historyBefore } : {}),
  };
}

export function contactLabel(c: Pick<Contact, 'name' | 'nickname'> | undefined): string {
  return c?.nickname?.trim() || c?.name || 'Unbekannt';
}
