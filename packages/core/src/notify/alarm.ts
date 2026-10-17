import type { Alarm, Alert } from '../state';

/**
 * The alert for an alarm the platform rang itself (the Windows app keeps alarms as timers): filed
 * and opened like the node's own alert for that deadline. A contact's watch leads to that contact
 * also when it is not loud; my own reminders lead to my watches.
 */
export function alarmAlert(alarm: Alarm, at: number): Alert {
  const base = { id: alarm.id, at, level: alarm.level, title: alarm.title, body: alarm.body };
  const theirs = /^watch:([0-9a-f]{64}):(.+)$/.exec(alarm.id);
  if (theirs) return { ...base, category: 'watch', from: theirs[1], thread: theirs[1], ref: { watchId: theirs[2]! } };
  const mine = /^mywatch:(.+):(remind|due)$/.exec(alarm.id);
  if (mine) return { ...base, category: 'watch', ref: { watchId: mine[1]! } };
  return { ...base, category: 'automation' };
}
