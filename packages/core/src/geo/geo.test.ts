import { describe, expect, it } from 'vitest';
import { distanceM } from './distance';
import { GeofenceTracker, type Place } from './geofence';
import { EtaEstimator } from '../eta/estimator';

const berlin = { lat: 52.520008, lon: 13.404954 };
const potsdam = { lat: 52.390569, lon: 13.064473 };

/** A point `meters` north of `p`. */
const north = (p: { lat: number; lon: number }, meters: number) => ({ lat: p.lat + meters / 111_195, lon: p.lon });

describe('distanceM', () => {
  it('matches the known Berlin to Potsdam distance (~26.8 km)', () => {
    expect(distanceM(berlin, potsdam)).toBeGreaterThan(26_000);
    expect(distanceM(berlin, potsdam)).toBeLessThan(27_500);
  });

  it('is zero for the same point', () => {
    expect(distanceM(berlin, berlin)).toBe(0);
  });
});

describe('GeofenceTracker', () => {
  const store: Place = { id: 'store', name: 'Supermarkt', center: berlin, radiusM: 100 };
  const fix = (meters: number, t: number, accuracyM = 10) => ({ ...north(berlin, meters), timestamp: t, accuracyM });

  it('does not announce the place you start in', () => {
    const g = new GeofenceTracker([store]);
    expect(g.update(fix(0, 0))).toEqual([]);
    expect(g.isInside('store')).toBe(true);
  });

  it('needs a dwell time before "arrive", so driving past does not count', () => {
    const g = new GeofenceTracker([store], { minDwellMs: 60_000 });
    g.update(fix(1000, 0));
    expect(g.update(fix(50, 10_000))).toEqual([]);
    expect(g.update(fix(500, 20_000))).toEqual([]); // drove on
    expect(g.update(fix(50, 30_000))).toEqual([]);
    expect(g.update(fix(40, 95_000))).toEqual([{ type: 'arrive', placeId: 'store', at: 95_000 }]);
  });

  it('absorbs jitter at the edge before "leave"', () => {
    const g = new GeofenceTracker([store], { exitMarginM: 50 });
    g.update(fix(0, 0));
    expect(g.update(fix(130, 1000))).toEqual([]);
    expect(g.update(fix(160, 2000))).toEqual([{ type: 'leave', placeId: 'store', at: 2000 }]);
  });

  it('ignores inaccurate fixes', () => {
    const g = new GeofenceTracker([store], { maxAccuracyM: 100 });
    g.update(fix(0, 0));
    expect(g.update(fix(5000, 1000, 500))).toEqual([]);
    expect(g.isInside('store')).toBe(true);
  });
});

describe('EtaEstimator', () => {
  it('uses observed speed', () => {
    const e = new EtaEstimator(berlin, { mode: 'car', detourFactor: 1 });
    const start = north(berlin, 10_000);
    e.update({ ...start, timestamp: 0 });
    // 1 km in 100 s = 10 m/s.
    const est = e.update({ ...north(berlin, 9_000), timestamp: 100_000 });
    expect(est.speedMps).toBeCloseTo(10, 0);
    expect(est.etaSeconds).toBeCloseTo(900, -1);
  });

  it('prefers the speed reported by the OS', () => {
    const e = new EtaEstimator(berlin, { detourFactor: 1 });
    const est = e.update({ ...north(berlin, 1400), timestamp: 0, speedMps: 1.4 });
    expect(est.etaSeconds).toBeCloseTo(1000, -1);
  });

  it('ignores teleports from bad fixes', () => {
    const e = new EtaEstimator(berlin, { mode: 'walk', detourFactor: 1 });
    e.update({ ...north(berlin, 1000), timestamp: 0 });
    const est = e.update({ ...north(berlin, 100_000), timestamp: 1000 });
    expect(est.speedMps).toBe(1.4);
  });
});
