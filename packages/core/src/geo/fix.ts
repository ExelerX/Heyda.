import { isValidLatLon, type LocationFix } from './types';

/**
 * How far a time may lie ahead of the clock it is compared with and still count as ordinary
 * jitter (GPS time vs system time, a fix taken just before it was handed over). Further ahead
 * means the clock jumped, e.g. the user set it back by hand.
 */
export const CLOCK_TOLERANCE_MS = 60_000;

/**
 * Time from `since` to `now` for pacing ("send at most every …"). When `since` lies further
 * ahead than the tolerance, the clock was set back since then: that counts as "long ago", so
 * pacing starts over instead of waiting, possibly for days, until the clock catches up.
 */
export function elapsedMs(since: number, now: number, toleranceMs: number = CLOCK_TOLERANCE_MS): number {
  const d = now - since;
  return d < -toleranceMs ? Number.POSITIVE_INFINITY : d;
}

/**
 * Checks a fix from the OS before anything uses it, and never throws.
 *
 * Returns `undefined` for a fix that can't be used: coordinates out of range, a time that is not
 * a positive finite number, or an accuracy that is not a finite number >= 0. A time further in
 * the future than the tolerance becomes `now`, so a later fix with a correct time still counts
 * as newer. A speed that is not a finite number is dropped, as is a missing (null) accuracy.
 * A fix that needs no change comes back as the same object.
 */
export function normalizeFix(fix: unknown, now: number, toleranceMs: number = CLOCK_TOLERANCE_MS): LocationFix | undefined {
  if (typeof fix !== 'object' || fix === null) return undefined;
  const { lat, lon, timestamp, accuracyM, speedMps } = fix as Record<keyof LocationFix, unknown>;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !isValidLatLon({ lat, lon })) return undefined;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  const accuracy = accuracyM ?? undefined;
  if (accuracy !== undefined && !(typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0)) return undefined;
  const speed = typeof speedMps === 'number' && Number.isFinite(speedMps) ? speedMps : undefined;
  const ahead = timestamp > now + toleranceMs;
  if (!ahead && accuracy === accuracyM && speed === speedMps) return fix as LocationFix;
  const out: LocationFix = { lat, lon, timestamp: ahead ? now : timestamp };
  if (accuracy !== undefined) out.accuracyM = accuracy;
  if (speed !== undefined) out.speedMps = speed;
  return out;
}

/**
 * `normalizeFix` for fixes the OS hands over together, and never throws. When the newest lies
 * further in the future than the tolerance, the whole batch moves back by the same amount, so
 * the newest becomes `now` and every fix keeps its spacing. (Each one on its own would land on
 * `now`, and then only the first, the oldest position, would count as new.) A fix the move puts
 * at or before 1970 is dropped. Anything that is not an array gives no fixes.
 */
export function normalizeFixes(fixes: readonly unknown[], now: number, toleranceMs: number = CLOCK_TOLERANCE_MS): LocationFix[] {
  if (!Array.isArray(fixes)) return [];
  const valid = fixes.map((f) => normalizeFix(f, now, Number.POSITIVE_INFINITY)).filter((f): f is LocationFix => f !== undefined);
  const newest = valid.reduce((max, f) => Math.max(max, f.timestamp), Number.NEGATIVE_INFINITY);
  if (!(newest > now + toleranceMs)) return valid;
  const shift = newest - now;
  return valid.flatMap((f) => (f.timestamp - shift > 0 ? [{ ...f, timestamp: f.timestamp - shift }] : []));
}
