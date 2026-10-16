import { distanceM } from '../geo/distance';
import { CLOCK_TOLERANCE_MS, elapsedMs } from '../geo/fix';
import type { LocationFix } from '../geo/types';
import { CoarseLocator, DEFAULT_CELL_M } from '../privacy/coarse-grid';
import type { Cell, Point } from '../protocol/messages';
import type { LiveShare, MySos } from '../state';

export interface LiveCadence {
  /** Precise: send after moving this far ... */
  minMoveM: number;
  /** ... but not more often than this. */
  minIntervalMs: number;
  /** Precise: resend at least this often even when standing still, so others see it is fresh. */
  heartbeatMs: number;
  /** Coarse: resend the same cell this often. */
  coarseHeartbeatMs: number;
}

export const LIVE_CADENCE: LiveCadence = {
  minMoveM: 25,
  minIntervalMs: 15_000,
  heartbeatMs: 5 * 60_000,
  coarseHeartbeatMs: 30 * 60_000,
};

export const SOS_CADENCE: LiveCadence = {
  minMoveM: 15,
  minIntervalMs: 15_000,
  heartbeatMs: 60_000,
  coarseHeartbeatMs: 60_000,
};

/**
 * Whether a live share still runs at `now`. One with an end also counts as over while `now` lies
 * before its start: the clock was set back, and waiting for the end could then take far longer
 * than the share was meant to last. An open-ended share runs until it is stopped.
 */
export function isLiveShareActive(share: Pick<LiveShare, 'startedAt' | 'expiresAt'>, now: number): boolean {
  if (share.expiresAt == null) return true;
  return now < share.expiresAt && now >= share.startedAt - CLOCK_TOLERANCE_MS;
}

/** How long an SOS keeps sending my location after each press. */
export const SOS_LOCATION_MS = 60 * 60_000;

/**
 * Whether my SOS still sends my location at `now`: until `locationUntil`, and not while `now`
 * lies before the press that set it (the clock was set back; waiting for `locationUntil` could
 * then take far longer than the promised hour).
 */
export function isSosLocationActive(sos: Pick<MySos, 'locationUntil'>, now: number): boolean {
  return now < sos.locationUntil && now >= sos.locationUntil - SOS_LOCATION_MS - CLOCK_TOLERANCE_MS;
}

/**
 * Decides, per location fix, whether a live-location update is due. Sends little:
 * on movement or a slow heartbeat, never on every fix.
 */
export class LiveTracker {
  private lastPoint: { lat: number; lon: number; at: number } | undefined;
  private coarse: CoarseLocator;
  private lastCellAt = -Infinity;

  constructor(
    private readonly cadence: LiveCadence = LIVE_CADENCE,
    private readonly cellM: number = DEFAULT_CELL_M,
  ) {
    this.coarse = new CoarseLocator(cellM);
  }

  /** Forget history so the next fix is sent right away (e.g. a new share started). */
  reset(): void {
    this.lastPoint = undefined;
    this.coarse = new CoarseLocator(this.cellM);
    this.lastCellAt = -Infinity;
  }

  /** Pacing uses `elapsedMs`: after the clock was set back it starts over instead of waiting for it to catch up. */
  precise(fix: LocationFix): Point | undefined {
    const last = this.lastPoint;
    const at = fix.timestamp;
    if (!Number.isFinite(at)) return undefined;
    if (last) {
      const since = elapsedMs(last.at, at);
      if (since < this.cadence.minIntervalMs) return undefined;
      if (since < this.cadence.heartbeatMs && distanceM(last, fix) < this.cadence.minMoveM) return undefined;
    }
    this.lastPoint = { lat: fix.lat, lon: fix.lon, at };
    return { lat: fix.lat, lon: fix.lon, accuracyM: Math.min(Math.max(fix.accuracyM ?? 50, 0), 10_000) };
  }

  cell(fix: LocationFix): Cell | undefined {
    if (!Number.isFinite(fix.timestamp)) return undefined;
    const changed = this.coarse.update(fix);
    const current = this.coarse.cell;
    if (!current) return undefined;
    if (!changed && elapsedMs(this.lastCellAt, fix.timestamp) < this.cadence.coarseHeartbeatMs) return undefined;
    this.lastCellAt = fix.timestamp;
    return { lat: current.lat, lon: current.lon, cellM: current.cellM };
  }
}
