/** German wording for times on the safety screens ("vor 2 Min.", "in 12 Min.", "14:05"). */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "14:05" in German format. */
export function hhmm(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "heute", "morgen", "gestern" or a short weekday with date. */
export function dayWord(at: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  if (diff === 2) return 'übermorgen';
  if (diff === -1) return 'gestern';
  try {
    return new Date(at).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
  } catch {
    return new Date(at).toDateString();
  }
}

/** "14:05" today, otherwise "morgen 14:05". */
export function clockWithDay(at: number, now = Date.now()): string {
  const day = dayWord(at, now);
  return day === 'heute' ? hhmm(at) : `${day} ${hhmm(at)}`;
}

/** A span like "5 Min.", "1 Std.", "2 Std. 15 Min.", "3 Tage". */
export function spanText(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} Min.`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} Std. ${rest} Min.` : `${h} Std.`;
  }
  const d = Math.round(m / 1440);
  return `${d} Tage`;
}

/** "gerade eben", "vor 2 Min.", "vor 3 Std.", "gestern", "vor 4 Tagen". */
export function ago(at: number, now = Date.now()): string {
  const ms = now - at;
  if (ms < MIN) return 'gerade eben';
  const m = Math.floor(ms / MIN);
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return d === 1 ? 'gestern' : `vor ${d} Tagen`;
}

/** "in 12 Min.", "in 1 Std. 5 Min.", "jetzt". */
export function inTime(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms < 30_000) return 'jetzt';
  return `in ${spanText(Math.max(ms, MIN))}`;
}

/** A ticking countdown: "14:32" (min:sec) or "1:05:12" (h:min:sec). */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Minutes from now until the next 07:00 local time, and whether that is tomorrow. */
export function untilSevenAm(now = Date.now()): { minutes: number; tomorrow: boolean } {
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 0, 0, 0);
  let tomorrow = false;
  if (target.getTime() <= now) {
    target.setDate(target.getDate() + 1);
    tomorrow = true;
  }
  return { minutes: Math.max(1, Math.round((target.getTime() - now) / MIN)), tomorrow };
}
