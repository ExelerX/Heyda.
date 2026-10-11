import { distanceM } from '../geo/distance';
import type { LocationFix } from '../geo/types';
import { CoarseLocator, DEFAULT_CELL_M } from '../privacy/coarse-grid';
import type { Cell, Point } from '../protocol/messages';

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

  precise(fix: LocationFix): Point | undefined {
    const last = this.lastPoint;
    const at = fix.timestamp;
    if (last) {
      const since = at - last.at;
      if (since < this.cadence.minIntervalMs) return undefined;
      if (since < this.cadence.heartbeatMs && distanceM(last, fix) < this.cadence.minMoveM) return undefined;
    }
    this.lastPoint = { lat: fix.lat, lon: fix.lon, at };
    return { lat: fix.lat, lon: fix.lon, accuracyM: Math.min(Math.max(fix.accuracyM ?? 50, 0), 10_000) };
  }

  cell(fix: LocationFix): Cell | undefined {
    const changed = this.coarse.update(fix);
    const current = this.coarse.cell;
    if (!current) return undefined;
    if (!changed && fix.timestamp - this.lastCellAt < this.cadence.coarseHeartbeatMs) return undefined;
    this.lastCellAt = fix.timestamp;
    return { lat: current.lat, lon: current.lon, cellM: current.cellM };
  }
}
