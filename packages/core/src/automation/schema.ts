import { z } from 'zod';
import { CheckinKind, PingKind } from '../protocol/messages';

/**
 * Automations are data, not code: a trigger, optional conditions and a few actions.
 * Templates (no code), puzzle blocks and AI suggestions all produce this same format,
 * so everything stays inspectable, shareable and safe to import.
 */

const contactKey = z.string().regex(/^[0-9a-f]{64}$/);
/** A concrete contact, or `any` for "anyone I'm connected to". */
export const ContactRef = z.union([contactKey, z.literal('any')]);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const placeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const label = (max: number) => z.string().trim().min(1).max(max);

export const Trigger = z.discriminatedUnion('on', [
  z.strictObject({ on: z.literal('contact.arrive'), contact: ContactRef, place: label(60).optional() }),
  z.strictObject({ on: z.literal('contact.leave'), contact: ContactRef, place: label(60).optional() }),
  z.strictObject({
    on: z.literal('contact.eta_below'),
    contact: ContactRef,
    /** 0 means "arriving now". */
    minutes: z.number().int().min(0).max(120),
  }),
  z.strictObject({ on: z.literal('contact.trip_start'), contact: ContactRef }),
  z.strictObject({
    on: z.literal('contact.trip_end'),
    contact: ContactRef,
    reason: z.enum(['arrived', 'stopped', 'expired']).optional(),
  }),
  z.strictObject({ on: z.literal('contact.message'), contact: ContactRef, contains: label(60).optional() }),
  z.strictObject({ on: z.literal('contact.ping'), contact: ContactRef, kind: PingKind.optional() }),
  z.strictObject({ on: z.literal('contact.checkin'), contact: ContactRef, kind: CheckinKind.optional() }),
  z.strictObject({ on: z.literal('contact.sos'), contact: ContactRef }),
  z.strictObject({ on: z.literal('me.arrive'), place: placeId }),
  z.strictObject({ on: z.literal('me.leave'), place: placeId }),
]);

export const Condition = z.discriminatedUnion('if', [
  /** Local time window; `from` > `to` wraps past midnight (22:00 to 06:00). */
  z.strictObject({ if: z.literal('time_between'), from: hhmm, to: hhmm }),
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  z.strictObject({ if: z.literal('weekday'), days: z.array(z.number().int().min(1).max(7)).min(1).max(7) }),
  z.strictObject({ if: z.literal('me.at'), place: placeId }),
  z.strictObject({ if: z.literal('me.not_at'), place: placeId }),
]);

export const Action = z.discriminatedUnion('do', [
  /** Local notification. Text may use {{contact}}, {{place}}, {{destination}}, {{eta}}, {{text}}. */
  z.strictObject({ do: z.literal('notify'), title: label(60), body: label(200) }),
  z.strictObject({ do: z.literal('send_ping'), to: contactKey, kind: PingKind, text: label(280).optional() }),
  /** A chat message. Text may use the same placeholders as notify. */
  z.strictObject({ do: z.literal('send_message'), to: contactKey, text: label(280) }),
  /** "Gut angekommen" and friends, to up to 10 people. */
  z.strictObject({
    do: z.literal('send_checkin'),
    to: z.array(contactKey).min(1).max(10),
    kind: CheckinKind,
    text: label(140).optional(),
  }),
  /** Quiet mode on for `minutes` (1 to 1440), or off with 0. */
  z.strictObject({ do: z.literal('set_dnd'), minutes: z.number().int().min(0).max(1440) }),
  z.strictObject({
    do: z.literal('set_status'),
    text: label(80),
    emoji: label(16).optional(),
    hours: z.number().int().min(1).max(24),
  }),
  /**
   * Starts sharing my ETA. Automations may only start the least revealing level,
   * and the phone always shows that sharing is running.
   */
  z.strictObject({
    do: z.literal('start_trip'),
    to: z.array(contactKey).min(1).max(10),
    destination: placeId,
    level: z.literal('eta'),
  }),
]);

export const RuleSource = z.enum(['template', 'blocks', 'ai', 'plugin', 'manual']);

export const Rule = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  name: label(60),
  enabled: z.boolean(),
  trigger: Trigger,
  conditions: z.array(Condition).max(8),
  actions: z.array(Action).min(1).max(5),
  source: RuleSource,
  templateId: z.string().max(120).optional(),
});

export type ContactRef = z.infer<typeof ContactRef>;
export type Trigger = z.infer<typeof Trigger>;
export type Condition = z.infer<typeof Condition>;
export type Action = z.infer<typeof Action>;
export type Rule = z.infer<typeof Rule>;
export type RuleSource = z.infer<typeof RuleSource>;

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function validateRule(input: unknown): ValidateResult<Rule> {
  const r = Rule.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || 'rule'}: ${i.message}`) };
}
