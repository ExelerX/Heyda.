import type { LocalTime } from '../automation/engine';

/**
 * Notification preferences and quiet mode ("Bitte nicht stören").
 *
 * Everything that reaches the user goes through `alertLevel`, so the rules for what may
 * interrupt are in one small, tested place. An SOS always interrupts; nothing can turn it off.
 */
export const ALERT_CATEGORIES = [
  'sos',
  'watch',
  'chat',
  'ping',
  'group',
  'checkin',
  'arrival',
  'trip',
  'live',
  'where',
  'status',
  'contact',
  'automation',
  'device',
] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/**
 * - `alarm`:  as loud as the device allows, tries to break through system Do Not Disturb
 * - `normal`: a regular notification with sound
 * - `silent`: shows up quietly, no sound
 * - `feed`:   no notification, only in the activity list
 */
export type AlertLevel = 'alarm' | 'normal' | 'silent' | 'feed';

export interface DndSchedule {
  enabled: boolean;
  /** HH:MM local time; `from` > `to` wraps past midnight (22:00 to 07:00). */
  from: string;
  to: string;
  /** ISO weekdays the quiet time starts on, 1 = Monday ... 7 = Sunday. */
  days: number[];
}

export interface DndSettings {
  /** Present while quiet mode is switched on by hand. `until` absent = until switched off. */
  manual?: { until?: number };
  schedule: DndSchedule;
  /** "I'll check in by …" alarms still ring. */
  allowWatch: boolean;
  /** Everything from favourites still comes through. */
  allowFavorites: boolean;
  /** Who may break through with a message marked urgent. */
  urgentFrom: 'all' | 'favorites' | 'none';
  /** Tell contacts that I'm in quiet mode, so they know they can mark something urgent. */
  share: boolean;
}

export interface NotificationPrefs {
  dnd: DndSettings;
  /** Categories that only go to the activity list. `sos` is ignored here on purpose. */
  off: AlertCategory[];
}

export const DEFAULT_PREFS: NotificationPrefs = {
  dnd: {
    schedule: { enabled: false, from: '22:00', to: '07:00', days: [1, 2, 3, 4, 5, 6, 7] },
    allowWatch: true,
    allowFavorites: true,
    urgentFrom: 'favorites',
    share: true,
  },
  off: ['status'],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(hhmm: string): number {
  if (!HHMM.test(hhmm)) throw new RangeError(`invalid time ${hhmm}`);
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

/** Is the scheduled quiet time running at this local time? */
export function scheduleActive(schedule: DndSchedule, t: LocalTime): boolean {
  if (!schedule.enabled) return false;
  const from = toMinutes(schedule.from);
  const to = toMinutes(schedule.to);
  if (from === to) return false;
  if (from < to) return schedule.days.includes(t.weekday) && t.minutes >= from && t.minutes < to;
  // Wraps midnight: the evening part belongs to today, the morning part to yesterday's start.
  if (t.minutes >= from) return schedule.days.includes(t.weekday);
  if (t.minutes < to) return schedule.days.includes(t.weekday === 1 ? 7 : t.weekday - 1);
  return false;
}

export function isDndActive(dnd: DndSettings, now: number, localTime: (now: number) => LocalTime): boolean {
  if (dnd.manual && (dnd.manual.until === undefined || now < dnd.manual.until)) return true;
  return scheduleActive(dnd.schedule, localTime(now));
}

/**
 * When the current quiet time ends, for telling contacts. `undefined` = until switched off.
 * Only meaningful while `isDndActive` is true.
 */
export function dndEndsAt(dnd: DndSettings, now: number, localTime: (now: number) => LocalTime): number | undefined {
  if (dnd.manual && (dnd.manual.until === undefined || now < dnd.manual.until)) return dnd.manual.until;
  const t = localTime(now);
  const to = toMinutes(dnd.schedule.to);
  const minutesLeft = (to - t.minutes + 1440) % 1440 || 1440;
  // Rounded to the minute; DST shifts are ignored, this is only a hint for others.
  return Math.floor(now / 60_000) * 60_000 + minutesLeft * 60_000;
}

export interface AlertSource {
  category: AlertCategory;
  favorite?: boolean;
  muted?: boolean;
  /** The sender asked to break through, and the rate limit allowed it. */
  urgent?: boolean;
}

export function alertLevel(source: AlertSource, prefs: NotificationPrefs, dndActive: boolean): AlertLevel {
  const { category } = source;
  if (category === 'sos') return 'alarm';
  if (category === 'watch') return dndActive && !prefs.dnd.allowWatch ? 'silent' : 'alarm';
  if (prefs.off.includes(category)) return 'feed';
  if (source.muted) return 'feed';
  if (!dndActive) return 'normal';
  if (source.favorite && prefs.dnd.allowFavorites) return 'normal';
  if (source.urgent && urgentAllowed(prefs.dnd.urgentFrom, source.favorite === true)) return 'normal';
  return 'silent';
}

function urgentAllowed(from: DndSettings['urgentFrom'], favorite: boolean): boolean {
  return from === 'all' || (from === 'favorites' && favorite);
}

/** Fills in anything missing (older saved data) and drops invalid values. */
export function normalizePrefs(input: Partial<NotificationPrefs> | undefined): NotificationPrefs {
  const d = input?.dnd;
  const s = d?.schedule;
  const validDays = (days: unknown) =>
    Array.isArray(days) ? [...new Set(days.filter((x) => Number.isInteger(x) && x >= 1 && x <= 7))].sort() : undefined;
  return {
    dnd: {
      manual: d?.manual && (d.manual.until === undefined || Number.isFinite(d.manual.until)) ? d.manual : undefined,
      schedule: {
        enabled: s?.enabled === true,
        from: s?.from && HHMM.test(s.from) ? s.from : DEFAULT_PREFS.dnd.schedule.from,
        to: s?.to && HHMM.test(s.to) ? s.to : DEFAULT_PREFS.dnd.schedule.to,
        days: validDays(s?.days) ?? DEFAULT_PREFS.dnd.schedule.days,
      },
      allowWatch: d?.allowWatch ?? DEFAULT_PREFS.dnd.allowWatch,
      allowFavorites: d?.allowFavorites ?? DEFAULT_PREFS.dnd.allowFavorites,
      urgentFrom: d?.urgentFrom && ['all', 'favorites', 'none'].includes(d.urgentFrom) ? d.urgentFrom : 'favorites',
      share: d?.share ?? DEFAULT_PREFS.dnd.share,
    },
    off: Array.isArray(input?.off)
      ? input.off.filter((c): c is AlertCategory => (ALERT_CATEGORIES as readonly string[]).includes(c) && c !== 'sos')
      : [...DEFAULT_PREFS.off],
  };
}
