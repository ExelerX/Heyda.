import { z } from 'zod';

/**
 * Wire format of everything one device sends to another.
 *
 * These payloads only ever travel inside the transport's end-to-end encryption.
 * Parsing is strict: unknown fields or types are rejected, and every string has a
 * length limit, because the sender is just another phone and may be buggy or hostile.
 */
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16 * 1024;

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const key = z.string().regex(/^[0-9a-f]{64}$/);
const shortText = (max: number) => z.string().trim().min(1).max(max);
/** Exported so every place that takes relay addresses (QR codes, rosters) accepts exactly what the wire accepts. */
export const RelayUrl = z
  .string()
  .max(200)
  .regex(/^wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[\w./-]*)?$/, 'relay must be a wss:// URL');
const relayUrl = RelayUrl;
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const time = z.number().int().nonnegative();

export const Point = z.strictObject({ lat, lon, accuracyM: z.number().min(0).max(10_000) });
export const Cell = z.strictObject({ lat, lon, cellM: z.number().int().min(100).max(100_000) });
export type Point = z.infer<typeof Point>;
export type Cell = z.infer<typeof Cell>;

export const PING_KINDS = [
  'help-carry',
  'pickup-request',
  'call-me',
  'dinner-ready',
  'running-late',
  'on-my-way',
  'thinking-of-you',
  'custom',
] as const;
export const PingKind = z.enum(PING_KINDS);
export type PingKind = z.infer<typeof PingKind>;

export const CHECKIN_KINDS = ['arrived', 'ok', 'home', 'custom'] as const;
export const CheckinKind = z.enum(CHECKIN_KINDS);
export type CheckinKind = z.infer<typeof CheckinKind>;

const member = z.strictObject({ key, name: shortText(40) });
/** Group members carry their relays, so members who are not each other's contacts can still talk. */
const groupMember = z.strictObject({ key, name: shortText(40), relays: z.array(relayUrl).max(8).optional() });

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  id,
  /** Sender's clock, epoch ms. Informational only; never trusted for security decisions. */
  sentAt: time,
};

const msg = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ ...envelope, type: z.literal(type), ...shape });

// ---- contacts ---------------------------------------------------------------------------

export const HelloMessage = msg('hello', {
  name: shortText(40),
  relays: z.array(relayUrl).max(8),
  /** Nonce from the scanned invite, proving this hello answers a real QR scan. */
  inviteNonce: id.optional(),
});

/** What I'm up to and whether I want quiet. Sent to all contacts when it changes. */
export const PresenceMessage = msg('presence', {
  status: z
    .strictObject({ text: shortText(80).optional(), emoji: shortText(16).optional(), expiresAt: time })
    .nullable(),
  /** Present while quiet mode is on and the sender chose to share it. `until` absent = until turned off. */
  dnd: z.strictObject({ until: time.optional() }).nullable(),
});

// ---- trips ----------------------------------------------------------------------------------

export const SessionStartMessage = msg('session.start', {
  sessionId: id,
  level: z.enum(['eta', 'coarse', 'precise']),
  destinationName: shortText(60),
  expiresAt: time,
});

export const SessionUpdateMessage = msg('session.update', {
  sessionId: id,
  /** Rounded minutes, 0 = arriving now. */
  etaMinutes: z.number().int().min(0).max(48 * 60).optional(),
  cell: Cell.optional(),
  point: Point.optional(),
});

export const SessionEndMessage = msg('session.end', {
  sessionId: id,
  reason: z.enum(['arrived', 'stopped', 'expired']),
});

export const PlaceEventMessage = msg('place.event', {
  kind: z.enum(['arrive', 'leave']),
  /** The label the sender gave the place. Coordinates are never sent. */
  placeName: shortText(60),
});

// ---- live location ----------------------------------------------------------------------

export const LiveStartMessage = msg('live.start', {
  shareId: id,
  level: z.enum(['coarse', 'precise']),
  /** Absent: until the sender turns it off. */
  expiresAt: time.optional(),
});

export const LiveUpdateMessage = msg('live.update', {
  shareId: id,
  cell: Cell.optional(),
  point: Point.optional(),
});

export const LiveEndMessage = msg('live.end', {
  shareId: id,
  reason: z.enum(['stopped', 'expired']),
});

// ---- safety ---------------------------------------------------------------------------------

export const CheckinMessage = msg('checkin', {
  kind: CheckinKind,
  text: shortText(140).optional(),
  placeName: shortText(60).optional(),
});

/** "Raise the alarm if I'm not there by dueAt." The alarm runs on the recipient's device. */
export const WatchStartMessage = msg('watch.start', {
  watchId: id,
  label: shortText(60),
  dueAt: time,
});

export const WatchEndMessage = msg('watch.end', {
  watchId: id,
  reason: z.enum(['ok', 'cancelled']),
});

export const SosStartMessage = msg('sos.start', {
  sosId: id,
  text: shortText(200).optional(),
  point: Point.optional(),
  /** Everyone else who got this alert, so helpers can coordinate. */
  others: z.array(member).max(20),
});

export const SosUpdateMessage = msg('sos.update', {
  sosId: id,
  point: Point.optional(),
  /** From the person in need: who is taking care, so helpers who don't know each other see it too. */
  acks: z.array(z.strictObject({ key, name: shortText(40), text: shortText(140).optional() })).max(20).optional(),
});

export const SosEndMessage = msg('sos.end', {
  sosId: id,
  reason: z.enum(['safe', 'cancelled']),
});

/** "I'm taking care of it." Sent to the person in need and to the other helpers. */
export const SosAckMessage = msg('sos.ack', {
  sosId: id,
  owner: key,
  text: shortText(140).optional(),
});

export const WhereRequestMessage = msg('where.request', {
  requestId: id,
});

export const WhereReplyMessage = msg('where.reply', {
  requestId: id,
  answer: z.enum(['declined', 'text', 'place', 'eta', 'coarse', 'precise']),
  text: shortText(140).optional(),
  placeName: shortText(60).optional(),
  etaMinutes: z.number().int().min(0).max(48 * 60).optional(),
  cell: Cell.optional(),
  point: Point.optional(),
});

// ---- chat -----------------------------------------------------------------------------------

export const ChatTextMessage = msg('chat.text', {
  text: shortText(4000),
  /** Asks to break through the recipient's quiet mode. The recipient decides whether it may. */
  urgent: z.boolean().optional(),
});

export const PingMessage = msg('ping', {
  kind: PingKind,
  text: shortText(280).optional(),
  urgent: z.boolean().optional(),
});

// ---- groups ---------------------------------------------------------------------------------

export const MAX_GROUP_MEMBERS = 30;

/** Full roster, sent by the group's owner. A higher version replaces a lower one. */
export const GroupUpdateMessage = msg('group.update', {
  groupId: id,
  name: shortText(40),
  owner: key,
  members: z.array(groupMember).min(1).max(MAX_GROUP_MEMBERS),
  version: z.number().int().min(1).max(1_000_000),
  dissolved: z.boolean().optional(),
});

export const GroupTextMessage = msg('group.text', {
  groupId: id,
  text: shortText(4000),
  urgent: z.boolean().optional(),
});

export const GroupLeaveMessage = msg('group.leave', {
  groupId: id,
});

// ---- own devices ------------------------------------------------------------------------------

export const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/);
/** A contact key, or `g:` plus a group id. */
export const ThreadId = z.string().regex(/^([0-9a-f]{64}|g:[A-Za-z0-9_-]{8,64})$/);

/** Copy of something I sent from another of my devices, so all of them show the same chat. */
export const SyncSentMessage = msg('sync.sent', {
  deviceId: DeviceId,
  thread: ThreadId,
  msgId: id,
  text: shortText(4000),
  kind: z.enum(['text', 'ping']),
  at: time,
});

/**
 * One of my "Pass auf mich auf", for my other devices: any of them can end it with a check-in
 * (also when the device that started it is off), and each reminds me. `ended` once it is over.
 * Older versions do not know this type and drop it.
 */
export const SyncWatchMessage = msg('sync.watch', {
  deviceId: DeviceId,
  watchId: id,
  recipients: z.array(key).min(1).max(100),
  label: shortText(60),
  dueAt: time,
  startedAt: time,
  ended: z.literal(true).optional(),
});

/** A newly linked device confirms it imported the account. */
export const LinkDoneMessage = msg('link.done', {
  deviceId: DeviceId,
  deviceName: shortText(40),
});

/** Nonce of a device-link code (`heyda-link:2:`), as the code itself carries it. */
export const LinkNonce = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
/** Exactly 32 bytes as unpadded base64url: 43 characters, the last one carrying only 4 bits. */
export const Bytes32 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

/**
 * Device link, step 2 (existing device → one-time key of the new device): answers a scanned
 * device code with the existing device's random share `rE`, chosen after it saw the commitment.
 */
export const LinkHelloMessage = msg('link.hello', {
  nonce: LinkNonce,
  rE: Bytes32,
  /** Where the existing device listens, so the new device can answer. */
  relays: z.array(relayUrl).max(8),
});

/**
 * Device link, step 3 (new device → existing device): opens the commitment from the code.
 * Only now can both sides work out the 6 digits; see `sync/link.ts`.
 */
export const LinkRevealMessage = msg('link.reveal', {
  nonce: LinkNonce,
  rN: Bytes32,
});

/** One slice of a larger payload (device link or settings sync). */
export const XferChunkMessage = msg('xfer.chunk', {
  xferId: id,
  purpose: z.enum(['link', 'sync']),
  part: z.number().int().min(0).max(99),
  total: z.number().int().min(1).max(100),
  /** base64url of UTF-8 JSON bytes. */
  data: z.string().regex(/^[A-Za-z0-9_-]{1,12000}$/),
});

export const AppMessage = z.discriminatedUnion('type', [
  HelloMessage,
  PresenceMessage,
  SessionStartMessage,
  SessionUpdateMessage,
  SessionEndMessage,
  PlaceEventMessage,
  LiveStartMessage,
  LiveUpdateMessage,
  LiveEndMessage,
  CheckinMessage,
  WatchStartMessage,
  WatchEndMessage,
  SosStartMessage,
  SosUpdateMessage,
  SosEndMessage,
  SosAckMessage,
  WhereRequestMessage,
  WhereReplyMessage,
  ChatTextMessage,
  PingMessage,
  GroupUpdateMessage,
  GroupTextMessage,
  GroupLeaveMessage,
  SyncSentMessage,
  SyncWatchMessage,
  LinkDoneMessage,
  LinkHelloMessage,
  LinkRevealMessage,
  XferChunkMessage,
]);

export type AppMessage = z.infer<typeof AppMessage>;
export type AppMessageType = AppMessage['type'];
export type MessageOf<T extends AppMessageType> = Extract<AppMessage, { type: T }>;

/** Message body without the envelope fields, as the app composes it. */
export type AppMessageBody = AppMessage extends infer M
  ? M extends AppMessage
    ? Omit<M, 'v' | 'id' | 'sentAt'>
    : never
  : never;

export type BodyOf<T extends AppMessageType> = Extract<AppMessageBody, { type: T }>;

export type ParseResult = { ok: true; message: AppMessage } | { ok: false; error: string };

export function parseAppMessage(raw: string): ParseResult {
  if (utf8Length(raw) > MAX_MESSAGE_BYTES) return { ok: false, error: 'message too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = AppMessage.safeParse(json);
  if (!result.success) return { ok: false, error: result.error.issues[0]?.message ?? 'invalid message' };
  return { ok: true, message: result.data };
}

export function serializeAppMessage(message: AppMessage): string {
  // Validate on the way out too, so a bug never sends something the other side rejects.
  const checked = AppMessage.parse(message);
  const raw = JSON.stringify(checked);
  if (utf8Length(raw) > MAX_MESSAGE_BYTES) throw new RangeError('message too large');
  return raw;
}

/** Whether a message would pass `serializeAppMessage`, i.e. could ever be sent. */
export function isSendable(message: AppMessage): boolean {
  try {
    serializeAppMessage(message);
    return true;
  } catch {
    return false;
  }
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
