/** German wording for times in the social screens ("vor 5 Min.", "in 12 Min.", "18:42"). */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "18:42" */
export function hhmm(at: number): string {
  return new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysBetween(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
}

/** "gerade eben", "vor 5 Min.", "vor 2 Std.", "gestern", "vor 3 Tagen" */
export function ago(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < MIN) return 'gerade eben';
  if (diff < HOUR) return `vor ${Math.floor(diff / MIN)} Min.`;
  if (diff < 12 * HOUR) return `vor ${Math.floor(diff / HOUR)} Std.`;
  const days = daysBetween(at, now);
  if (days <= 0) return `heute, ${hhmm(at)}`;
  if (days === 1) return `gestern, ${hhmm(at)}`;
  return `vor ${days} Tagen`;
}

/** "gleich", "in 12 Min.", "in 1 Std. 20 Min.", "morgen, 07:00" */
export function inTime(until: number, now = Date.now()): string {
  const diff = until - now;
  if (diff <= 30_000) return 'gleich';
  const m = Math.ceil(diff / MIN);
  if (m < 60) return `in ${m} Min.`;
  if (diff < 12 * HOUR) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `in ${h} Std. ${rest} Min.` : `in ${h} Std.`;
  }
  const days = daysBetween(now, until);
  if (days <= 0) return `heute, ${hhmm(until)}`;
  if (days === 1) return `morgen, ${hhmm(until)}`;
  return `${new Date(until).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })}, ${hhmm(until)}`;
}

/** "noch 12 Min.", "noch 1 Std. 20 Min." */
export function remaining(until: number, now = Date.now()): string {
  const m = Math.max(0, Math.ceil((until - now) / MIN));
  if (m < 60) return `noch ${m} Min.`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h >= 24) return `bis ${inTime(until, now).replace(/^in /, '')}`;
  return rest ? `noch ${h} Std. ${rest} Min.` : `noch ${h} Std.`;
}

/** Arrival wording for a rounded ETA in minutes. */
export function etaWords(minutes: number | undefined): string {
  if (minutes === undefined) return 'unterwegs';
  if (minutes <= 0) return 'gleich da';
  if (minutes < 60) return `ca. ${minutes} Min.`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `ca. ${h} Std. ${m} Min.` : `ca. ${h} Std.`;
}

/** "15 Min.", "1 Std.", "24 Std." */
export function durationWords(ms: number): string {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m} Min.`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} Std. ${rest} Min.` : `${h} Std.`;
}

/** Day separators in chats and lists: "Heute", "Gestern", "Montag, 3. Oktober". */
export function dayLabel(at: number, now = Date.now()): string {
  const days = daysBetween(at, now);
  if (days === 0) return 'Heute';
  if (days === 1) return 'Gestern';
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** Short time for list rows: "18:42" today, "Gestern", "Mo.", "03.10.24". */
export function listTime(at: number, now = Date.now()): string {
  const days = daysBetween(at, now);
  if (days <= 0) return hhmm(at);
  if (days === 1) return 'Gestern';
  if (days < 7) return new Date(at).toLocaleDateString('de-DE', { weekday: 'short' });
  return new Date(at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** "52.52080, 13.40940" */
export function coords(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** The message of an error, for `notice`. */
export function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Etwas ist schiefgelaufen. Versuch es nochmal.';
}
