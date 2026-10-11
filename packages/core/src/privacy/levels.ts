/**
 * How much location detail a contact may receive, from least to most revealing.
 *
 * - `event`:   only arrive/leave at places the sender named ("Lisa is at the store")
 * - `eta`:     additionally a rounded arrival time during an active trip
 * - `coarse`:  additionally a fixed grid cell (default 2 km)
 * - `precise`: an exact point; only ever time-limited
 */
export const SHARE_LEVELS = ['event', 'eta', 'coarse', 'precise'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];

/** Longest a precise trip may run before it must be renewed explicitly (same as any trip). */
export const MAX_PRECISE_SHARE_MS = 24 * 60 * 60 * 1000;

export function levelRank(level: ShareLevel): number {
  return SHARE_LEVELS.indexOf(level);
}

/** True when a grant of `granted` covers data that needs `needed`. */
export function levelAllows(granted: ShareLevel, needed: ShareLevel): boolean {
  return levelRank(granted) >= levelRank(needed);
}
