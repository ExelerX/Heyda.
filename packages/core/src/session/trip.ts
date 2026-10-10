import { distanceM } from '../geo/distance';
import type { LocationFix } from '../geo/types';
import { EtaEstimator, type TravelMode } from '../eta/estimator';
import { CoarseLocator, DEFAULT_CELL_M } from '../privacy/coarse-grid';
import { bucketEtaMinutes } from '../privacy/eta-rounding';
import type { AppMessageBody } from '../protocol/messages';
import { isSessionActive, type SharingSession } from './session';

export interface TripOptions {
  mode?: TravelMode;
  /** Within this distance of the destination the trip ends as "arrived". */
  arrivalRadiusM?: number;
  /** Minimum gap between precise point updates. */
  preciseIntervalMs?: number;
  cellM?: number;
}

/**
 * Turns location fixes during one trip into the few messages recipients need.
 * It sends only on change (a new ETA step, a new grid cell), never on every fix,
 * which saves battery and leaks less.
 */
export class TripSharer {
  private readonly estimator: EtaEstimator | undefined;
  private readonly coarse: CoarseLocator | undefined;
  private readonly arrivalRadiusM: number;
  private readonly preciseIntervalMs: number;
  private lastEta: number | undefined;
  private lastPointAt = -Infinity;
  private ended = false;

  constructor(
    readonly session: SharingSession,
    options: TripOptions = {},
  ) {
    this.estimator = session.destination
      ? new EtaEstimator(session.destination, { mode: options.mode })
      : undefined;
    this.coarse =
      session.level === 'coarse' || session.level === 'precise'
        ? new CoarseLocator(options.cellM ?? DEFAULT_CELL_M)
        : undefined;
    this.arrivalRadiusM = options.arrivalRadiusM ?? 75;
    this.preciseIntervalMs = options.preciseIntervalMs ?? 30_000;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  startMessage(): AppMessageBody {
    return {
      type: 'session.start',
      sessionId: this.session.id,
      level: this.session.level,
      destinationName: this.session.destinationName,
      expiresAt: this.session.expiresAt,
    };
  }

  stopMessage(): AppMessageBody {
    return this.end('stopped');
  }

  onFix(fix: LocationFix): AppMessageBody[] {
    if (this.ended) return [];
    if (!isSessionActive(this.session, fix.timestamp)) return [this.end('expired')];

    if (this.session.destination && distanceM(fix, this.session.destination) <= this.arrivalRadiusM) {
      return [this.end('arrived')];
    }

    const update: Extract<AppMessageBody, { type: 'session.update' }> = {
      type: 'session.update',
      sessionId: this.session.id,
    };
    let changed = false;

    if (this.estimator) {
      const eta = bucketEtaMinutes(this.estimator.update(fix).etaSeconds);
      if (eta !== this.lastEta) {
        this.lastEta = eta;
        update.etaMinutes = eta;
        changed = true;
      }
    }

    if (this.session.level === 'precise') {
      if (fix.timestamp - this.lastPointAt >= this.preciseIntervalMs) {
        this.lastPointAt = fix.timestamp;
        update.point = {
          lat: fix.lat,
          lon: fix.lon,
          accuracyM: Math.min(fix.accuracyM ?? 50, 10_000),
        };
        changed = true;
      }
    } else if (this.coarse) {
      const cell = this.coarse.update(fix);
      if (cell) {
        update.cell = { lat: cell.lat, lon: cell.lon, cellM: cell.cellM };
        changed = true;
      }
    }

    return changed ? [update] : [];
  }

  private end(reason: 'arrived' | 'stopped' | 'expired'): AppMessageBody {
    this.ended = true;
    return { type: 'session.end', sessionId: this.session.id, reason };
  }
}
