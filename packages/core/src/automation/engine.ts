import { CLOCK_TOLERANCE_MS } from '../geo/fix';
import type { CheckinKind, PingKind } from '../protocol/messages';
import type { ContactKey } from '../transport/transport';
import type { Action, Condition, Rule, Trigger } from './schema';

/**
 * What happened. Contact events come from messages the contact chose to send,
 * so an automation can never learn more than the contact already shared.
 */
export type AutomationEvent =
  | { type: 'contact.arrive'; contact: ContactKey; placeName: string; at: number }
  | { type: 'contact.leave'; contact: ContactKey; placeName: string; at: number }
  | {
      type: 'contact.eta';
      contact: ContactKey;
      sessionId: string;
      etaMinutes: number;
      destinationName: string;
      at: number;
    }
  | { type: 'contact.trip_start'; contact: ContactKey; sessionId: string; destinationName: string; at: number }
  | {
      type: 'contact.trip_end';
      contact: ContactKey;
      sessionId: string;
      reason: 'arrived' | 'stopped' | 'expired';
      at: number;
    }
  | { type: 'contact.message'; contact: ContactKey; text: string; at: number }
  | { type: 'contact.ping'; contact: ContactKey; kind: PingKind; text?: string; at: number }
  | { type: 'contact.checkin'; contact: ContactKey; kind: CheckinKind; text?: string; placeName?: string; at: number }
  | { type: 'contact.sos'; contact: ContactKey; at: number }
  | { type: 'me.arrive'; placeId: string; at: number }
  | { type: 'me.leave'; placeId: string; at: number };

/** A resolved action for the app to carry out. The engine itself has no side effects. */
export type ActionIntent =
  | { kind: 'notify'; ruleId: string; title: string; body: string }
  | { kind: 'send_ping'; ruleId: string; to: ContactKey; pingKind: PingKind; text?: string }
  | { kind: 'send_message'; ruleId: string; to: ContactKey; text: string }
  | { kind: 'send_checkin'; ruleId: string; to: ContactKey[]; checkinKind: CheckinKind; text?: string }
  | { kind: 'set_dnd'; ruleId: string; minutes: number }
  | { kind: 'set_status'; ruleId: string; text: string; emoji?: string; hours: number }
  | { kind: 'start_trip'; ruleId: string; to: ContactKey[]; destination: string; level: 'eta' };

export interface LocalTime {
  /** Minutes since local midnight. */
  minutes: number;
  /** ISO weekday, 1 = Monday ... 7 = Sunday. */
  weekday: number;
}

export interface EngineLimits {
  /** Minimum gap between two firings of the same rule. */
  ruleCooldownMs: number;
  /** Per rule, per rolling hour. */
  maxFiresPerRulePerHour: number;
  /** Messages automations may send to one contact per rolling hour. */
  maxPingsPerContactPerHour: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  ruleCooldownMs: 60_000,
  maxFiresPerRulePerHour: 20,
  maxPingsPerContactPerHour: 10,
};

export interface EngineContext {
  rules: () => Rule[];
  contactName: (key: ContactKey) => string;
  placeName: (placeId: string) => string | undefined;
  isAtPlace: (placeId: string) => boolean;
  localTime?: (now: number) => LocalTime;
  limits?: Partial<EngineLimits>;
}

const HOUR = 60 * 60 * 1000;

/**
 * When a rule fired, or an automation messaged someone, for the cooldown and the hourly caps.
 * `at` is the time it happened. `noLaterThan` starts the same and moves back to `now` whenever
 * `now` lies further before `at` than the tolerance: the clock was set back since. A stamp counts
 * while either time says it is recent, so the limits still hold right after the clock was set
 * back, but for at most their own length from then on, not until the clock catches up.
 */
interface Stamp {
  at: number;
  noLaterThan: number;
}

/** Whether a stamp is less than `windowMs` before `now`, or only a little after it (event clocks differ slightly). */
function isRecent(s: Stamp, now: number, windowMs: number): boolean {
  const recent = (t: number) => now - t >= -CLOCK_TOLERANCE_MS && now - t < windowMs;
  return recent(s.at) || recent(s.noLaterThan);
}

export function systemLocalTime(now: number): LocalTime {
  const d = new Date(now);
  const day = d.getDay();
  return { minutes: d.getHours() * 60 + d.getMinutes(), weekday: day === 0 ? 7 : day };
}

export class AutomationEngine {
  private readonly limits: EngineLimits;
  private readonly localTime: (now: number) => LocalTime;
  private readonly fires = new Map<string, Stamp[]>();
  private readonly pings = new Map<ContactKey, Stamp[]>();
  /** `ruleId|sessionId` pairs whose ETA threshold already fired. */
  private readonly etaFired = new Set<string>();

  constructor(private readonly ctx: EngineContext) {
    this.limits = { ...DEFAULT_LIMITS, ...ctx.limits };
    this.localTime = ctx.localTime ?? systemLocalTime;
  }

  /**
   * `now` is the clock the cooldown and the hourly caps are measured with. Pass the same clock
   * for every event (event times may come from different clocks, e.g. a place event carries the
   * time of its fix). Conditions like `time_between` use the event's time.
   */
  handle(event: AutomationEvent, now: number = event.at): ActionIntent[] {
    if (event.type === 'contact.trip_end') this.forgetSession(event.sessionId);
    this.settle(now);

    const intents: ActionIntent[] = [];
    for (const rule of this.ctx.rules()) {
      if (!rule.enabled || !this.matches(rule, event)) continue;
      if (!rule.conditions.every((c) => this.holds(c, event.at))) continue;
      if (!this.allowFire(rule.id, now)) continue;
      if (rule.trigger.on === 'contact.eta_below' && event.type === 'contact.eta') {
        this.etaFired.add(`${rule.id}|${event.sessionId}`);
      }
      for (const action of rule.actions) {
        const intent = this.resolve(rule, action, event, now);
        if (intent) intents.push(intent);
      }
    }
    return intents;
  }

  private matches(rule: Rule, event: AutomationEvent): boolean {
    const t: Trigger = rule.trigger;
    const contactOk = (ref: string, key: ContactKey) => ref === 'any' || ref === key;
    const placeOk = (want: string | undefined, got: string) =>
      want === undefined || want.toLocaleLowerCase() === got.toLocaleLowerCase();

    switch (t.on) {
      case 'contact.arrive':
        return event.type === 'contact.arrive' && contactOk(t.contact, event.contact) && placeOk(t.place, event.placeName);
      case 'contact.leave':
        return event.type === 'contact.leave' && contactOk(t.contact, event.contact) && placeOk(t.place, event.placeName);
      case 'contact.eta_below':
        return (
          event.type === 'contact.eta' &&
          contactOk(t.contact, event.contact) &&
          event.etaMinutes <= t.minutes &&
          !this.etaFired.has(`${rule.id}|${event.sessionId}`)
        );
      case 'contact.trip_start':
        return event.type === 'contact.trip_start' && contactOk(t.contact, event.contact);
      case 'contact.trip_end':
        return (
          event.type === 'contact.trip_end' &&
          contactOk(t.contact, event.contact) &&
          (t.reason === undefined || t.reason === event.reason)
        );
      case 'contact.message':
        return (
          event.type === 'contact.message' &&
          contactOk(t.contact, event.contact) &&
          (t.contains === undefined || event.text.toLocaleLowerCase().includes(t.contains.toLocaleLowerCase()))
        );
      case 'contact.ping':
        return (
          event.type === 'contact.ping' &&
          contactOk(t.contact, event.contact) &&
          (t.kind === undefined || t.kind === event.kind)
        );
      case 'contact.checkin':
        return (
          event.type === 'contact.checkin' &&
          contactOk(t.contact, event.contact) &&
          (t.kind === undefined || t.kind === event.kind)
        );
      case 'contact.sos':
        return event.type === 'contact.sos' && contactOk(t.contact, event.contact);
      case 'me.arrive':
        return event.type === 'me.arrive' && event.placeId === t.place;
      case 'me.leave':
        return event.type === 'me.leave' && event.placeId === t.place;
    }
  }

  private holds(c: Condition, now: number): boolean {
    switch (c.if) {
      case 'time_between': {
        const m = this.localTime(now).minutes;
        const from = toMinutes(c.from);
        const to = toMinutes(c.to);
        return from <= to ? m >= from && m < to : m >= from || m < to;
      }
      case 'weekday':
        return c.days.includes(this.localTime(now).weekday);
      case 'me.at':
        return this.ctx.isAtPlace(c.place);
      case 'me.not_at':
        return !this.ctx.isAtPlace(c.place);
    }
  }

  /** Moves the stamps that `now` lies before (see `Stamp`) and drops those that no longer count. */
  private settle(now: number): void {
    for (const map of [this.fires, this.pings]) {
      for (const [key, stamps] of map) {
        const recent = stamps
          .map((s) => (s.at - now > CLOCK_TOLERANCE_MS ? { at: s.at, noLaterThan: Math.min(s.noLaterThan, now) } : s))
          .filter((s) => isRecent(s, now, HOUR));
        if (recent.length) map.set(key, recent);
        else map.delete(key);
      }
    }
  }

  /** Expects `settle(now)` to have run for this event. */
  private allowFire(ruleId: string, now: number): boolean {
    const recent = this.fires.get(ruleId) ?? [];
    if (recent.some((s) => isRecent(s, now, this.limits.ruleCooldownMs))) return false;
    if (recent.length >= this.limits.maxFiresPerRulePerHour) return false;
    this.fires.set(ruleId, [...recent, { at: now, noLaterThan: now }]);
    return true;
  }

  /** Expects `settle(now)` to have run for this event. */
  private allowPing(to: ContactKey, now: number): boolean {
    const recent = this.pings.get(to) ?? [];
    if (recent.length >= this.limits.maxPingsPerContactPerHour) return false;
    this.pings.set(to, [...recent, { at: now, noLaterThan: now }]);
    return true;
  }

  private resolve(rule: Rule, action: Action, event: AutomationEvent, now: number): ActionIntent | undefined {
    const vars = this.variables(event);
    switch (action.do) {
      case 'notify':
        return {
          kind: 'notify',
          ruleId: rule.id,
          title: render(action.title, vars, 60),
          body: render(action.body, vars, 200),
        };
      case 'send_ping':
        if (!this.allowPing(action.to, now)) return undefined;
        return {
          kind: 'send_ping',
          ruleId: rule.id,
          to: action.to,
          pingKind: action.kind,
          text: action.text === undefined ? undefined : render(action.text, vars, 280),
        };
      case 'start_trip':
        return { kind: 'start_trip', ruleId: rule.id, to: action.to, destination: action.destination, level: 'eta' };
      case 'send_message':
        if (!this.allowPing(action.to, now)) return undefined;
        return { kind: 'send_message', ruleId: rule.id, to: action.to, text: render(action.text, vars, 280) };
      case 'send_checkin': {
        const to = action.to.filter((k) => this.allowPing(k, now));
        if (!to.length) return undefined;
        return {
          kind: 'send_checkin',
          ruleId: rule.id,
          to,
          checkinKind: action.kind,
          text: action.text === undefined ? undefined : render(action.text, vars, 140),
        };
      }
      case 'set_dnd':
        return { kind: 'set_dnd', ruleId: rule.id, minutes: action.minutes };
      case 'set_status':
        return {
          kind: 'set_status',
          ruleId: rule.id,
          text: render(action.text, vars, 80),
          emoji: action.emoji,
          hours: action.hours,
        };
    }
  }

  private variables(event: AutomationEvent): Record<string, string> {
    const vars: Record<string, string> = {};
    if ('contact' in event) vars.contact = this.ctx.contactName(event.contact);
    if ('placeName' in event && event.placeName !== undefined) vars.place = event.placeName;
    if ('placeId' in event) vars.place = this.ctx.placeName(event.placeId) ?? '';
    if ('destinationName' in event) vars.destination = event.destinationName;
    if (event.type === 'contact.eta') vars.eta = event.etaMinutes === 0 ? 'gleich' : `in ca. ${event.etaMinutes} min`;
    if ('text' in event && event.text !== undefined) vars.text = event.text;
    return vars;
  }

  private forgetSession(sessionId: string): void {
    for (const key of this.etaFired) if (key.endsWith(`|${sessionId}`)) this.etaFired.delete(key);
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Fills {{name}} placeholders from a fixed set of variables. No expressions, no code:
 * unknown placeholders become empty, and the result is cut to `max` characters.
 */
export function render(template: string, vars: Record<string, string>, max: number): string {
  const out = template.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (_, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? '') : '',
  );
  return [...out].slice(0, max).join('');
}
