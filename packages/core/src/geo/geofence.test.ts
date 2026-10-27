import { describe, expect, it } from 'vitest';
import { GeofenceTracker } from './geofence';

const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });
const T = 1_700_000_000_000;
const HOUR = 3600_000;
const fix = (meters: number, timestamp: number) => ({ ...north(meters), timestamp, accuracyM: 10 });

describe('GeofenceTracker and the clock', () => {
  const places = [{ id: 'home', name: 'Zuhause', center: home, radiusM: 100 }];

  it('starts the dwell time again when the clock jumps back, instead of waiting for it to catch up', () => {
    const g = new GeofenceTracker(places, { minDwellMs: 60_000 });
    expect(g.update(fix(500, T))).toEqual([]); // starts outside
    expect(g.update(fix(0, T + 10_000))).toEqual([]); // inside, the dwell time starts
    expect(g.update(fix(0, T - HOUR))).toEqual([]); // clock set back
    expect(g.update(fix(0, T - HOUR + 30_000))).toEqual([]); // a full dwell time is still needed
    expect(g.update(fix(0, T - HOUR + 61_000))).toEqual([{ type: 'arrive', placeId: 'home', at: T - HOUR + 61_000 }]);
  });

  it('keeps the dwell time through a few seconds of jitter', () => {
    const g = new GeofenceTracker(places, { minDwellMs: 60_000 });
    g.update(fix(500, T));
    g.update(fix(0, T + 10_000));
    expect(g.update(fix(0, T + 8_000))).toEqual([]);
    expect(g.update(fix(0, T + 70_000))).toEqual([{ type: 'arrive', placeId: 'home', at: T + 70_000 }]);
  });
});
