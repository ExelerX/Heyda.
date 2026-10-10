/** ETAs at or below this many seconds are reported as "arriving" instead of a number. */
export const ARRIVING_THRESHOLD_S = 120;

/**
 * Rounds an ETA up to a coarse step so the recipient learns roughly when, not exactly where.
 * Coarse far away, finer close to arrival, which is when it matters.
 *
 * Returns whole minutes; `0` means "arriving now".
 *
 * | ETA            | step   |
 * | -------------- | ------ |
 * | <= 2 min       | 0      |
 * | < 10 min       | 1 min  |
 * | < 30 min       | 5 min  |
 * | < 2 h          | 10 min |
 * | otherwise      | 30 min |
 */
export function bucketEtaMinutes(etaSeconds: number): number {
  if (!Number.isFinite(etaSeconds) || etaSeconds <= ARRIVING_THRESHOLD_S) return 0;
  const minutes = etaSeconds / 60;
  const step = minutes < 10 ? 1 : minutes < 30 ? 5 : minutes < 120 ? 10 : 30;
  return Math.ceil(minutes / step) * step;
}
