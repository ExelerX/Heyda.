import { distanceM } from '../geo/distance';
import type { LatLon, LocationFix } from '../geo/types';

export type TravelMode = 'walk' | 'bike' | 'car' | 'transit';

/** Typical average speeds in m/s, used until enough real movement has been observed. */
export const DEFAULT_SPEED_MPS: Record<TravelMode, number> = {
  walk: 1.4,
  bike: 4.5,
  car: 11,
  transit: 7,
};

export interface EtaEstimatorOptions {
  mode?: TravelMode;
  /**
   * Roads are longer than the straight line. 1.3 is a common rule of thumb;
   * tune it per user once real trips have been recorded.
   */
  detourFactor?: number;
  /** Weight of the newest speed sample in the exponential moving average (0..1). */
  smoothing?: number;
  /** Below this speed the device counts as standing still (traffic light, shop). */
  minMovingSpeedMps?: number;
}

export interface EtaEstimate {
  /** Straight-line distance in meters. */
  distanceM: number;
  /** Estimated seconds until arrival. */
  etaSeconds: number;
  /** Speed used for the estimate, m/s. */
  speedMps: number;
}

/**
 * Estimates the arrival time fully on the device, without any routing service,
 * so neither start nor destination ever leaves the phone.
 *
 * Accuracy is lower than turn-by-turn routing, which is acceptable because the
 * result is rounded anyway (see `bucketEtaMinutes`).
 */
export class EtaEstimator {
  private readonly mode: TravelMode;
  private readonly detourFactor: number;
  private readonly smoothing: number;
  private readonly minMoving: number;
  private smoothedSpeed: number | undefined;
  private last: LocationFix | undefined;

  constructor(
    private readonly destination: LatLon,
    options: EtaEstimatorOptions = {},
  ) {
    this.mode = options.mode ?? 'car';
    this.detourFactor = options.detourFactor ?? 1.3;
    this.smoothing = options.smoothing ?? 0.3;
    this.minMoving = options.minMovingSpeedMps ?? 0.5;
  }

  update(fix: LocationFix): EtaEstimate {
    const sample = this.speedSample(fix);
    if (sample !== undefined && sample >= this.minMoving) {
      this.smoothedSpeed =
        this.smoothedSpeed === undefined
          ? sample
          : this.smoothing * sample + (1 - this.smoothing) * this.smoothedSpeed;
    }
    this.last = fix;

    const dist = distanceM(fix, this.destination);
    // Never assume slower than walking pace for the mode default, so a long stop does not explode the ETA.
    const speed = Math.max(this.smoothedSpeed ?? DEFAULT_SPEED_MPS[this.mode], DEFAULT_SPEED_MPS.walk);
    return { distanceM: dist, etaSeconds: (dist * this.detourFactor) / speed, speedMps: speed };
  }

  private speedSample(fix: LocationFix): number | undefined {
    if (fix.speedMps !== undefined && fix.speedMps >= 0) return fix.speedMps;
    if (!this.last) return undefined;
    const dt = (fix.timestamp - this.last.timestamp) / 1000;
    if (dt < 1) return undefined;
    const v = distanceM(this.last, fix) / dt;
    // Reject teleports from bad fixes (faster than ~300 km/h).
    return v > 85 ? undefined : v;
  }
}
