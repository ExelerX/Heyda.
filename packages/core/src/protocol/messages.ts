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
const shortText = (max: number) => z.string().trim().min(1).max(max);
const relayUrl = z
  .string()
  .max(200)
  .regex(/^wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[\w./-]*)?$/, 'relay must be a wss:// URL');
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  id,
  /** Sender's clock, epoch ms. Informational only; never trusted for security decisions. */
  sentAt: z.number().int().nonnegative(),
};

export const HelloMessage = z.strictObject({
  ...envelope,
  type: z.literal('hello'),
  name: shortText(40),
  relays: z.array(relayUrl).max(8),
  /** Nonce from the scanned invite, proving this hello answers a real QR scan. */
  inviteNonce: id.optional(),
});

export const SessionStartMessage = z.strictObject({
  ...envelope,
  type: z.literal('session.start'),
  sessionId: id,
  level: z.enum(['eta', 'coarse', 'precise']),
  destinationName: shortText(60),
  expiresAt: z.number().int().nonnegative(),
});

export const SessionUpdateMessage = z.strictObject({
  ...envelope,
  type: z.literal('session.update'),
  sessionId: id,
  /** Rounded minutes, 0 = arriving now. */
  etaMinutes: z.number().int().min(0).max(24 * 60).optional(),
  cell: z.strictObject({ lat, lon, cellM: z.number().int().min(100).max(100_000) }).optional(),
  point: z.strictObject({ lat, lon, accuracyM: z.number().min(0).max(10_000) }).optional(),
});

export const SessionEndMessage = z.strictObject({
  ...envelope,
  type: z.literal('session.end'),
  sessionId: id,
  reason: z.enum(['arrived', 'stopped', 'expired']),
});

export const PlaceEventMessage = z.strictObject({
  ...envelope,
  type: z.literal('place.event'),
  kind: z.enum(['arrive', 'leave']),
  /** The label the sender gave the place. Coordinates are never sent. */
  placeName: shortText(60),
});

export const ChatTextMessage = z.strictObject({
  ...envelope,
  type: z.literal('chat.text'),
  text: shortText(4000),
});

export const PingMessage = z.strictObject({
  ...envelope,
  type: z.literal('ping'),
  kind: z.enum(['help-carry', 'pickup-request', 'custom']),
  text: shortText(280).optional(),
});

export const AppMessage = z.discriminatedUnion('type', [
  HelloMessage,
  SessionStartMessage,
  SessionUpdateMessage,
  SessionEndMessage,
  PlaceEventMessage,
  ChatTextMessage,
  PingMessage,
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

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
