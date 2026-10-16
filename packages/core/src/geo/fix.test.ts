import { describe, expect, it } from 'vitest';
import { CLOCK_TOLERANCE_MS, elapsedMs, normalizeFix } from './fix';

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;
const ok = { lat: 52.52, lon: 13.405, timestamp: NOW - 1000, accuracyM: 10, speedMps: 3 };

describe('normalizeFix', () => {
  it('passes a normal fix through as it is', () => {
    expect(normalizeFix(ok, NOW)).toBe(ok);
    const minimal = { lat: -90, lon: 180, timestamp: NOW };
    expect(normalizeFix(minimal, NOW)).toBe(minimal);
  });

  it('takes a fix dated in the future as now, beyond a small tolerance', () => {
    const soon = { ...ok, timestamp: NOW + CLOCK_TOLERANCE_MS };
    expect(normalizeFix(soon, NOW)).toBe(soon);
    expect(normalizeFix({ ...ok, timestamp: NOW + HOUR }, NOW)).toEqual({ ...ok, timestamp: NOW });
    expect(normalizeFix({ ...ok, timestamp: NOW + 10 * 365 * 24 * HOUR }, NOW)?.timestamp).toBe(NOW);
  });

  it('keeps an old fix as it is (it may come late from the OS)', () => {
    const old = { ...ok, timestamp: NOW - 24 * HOUR };
    expect(normalizeFix(old, NOW)).toBe(old);
  });

  it('drops fixes with broken coordinates, time or accuracy, without throwing', () => {
    const broken: unknown[] = [
      null,
      undefined,
      42,
      'here',
      {},
      { ...ok, lat: Number.NaN },
      { ...ok, lat: 90.0001 },
      { ...ok, lat: -91 },
      { ...ok, lon: 180.5 },
      { ...ok, lon: Number.NEGATIVE_INFINITY },
      { ...ok, lat: '52.5' },
      { ...ok, timestamp: undefined },
      { ...ok, timestamp: Number.NaN },
      { ...ok, timestamp: Number.POSITIVE_INFINITY },
      { ...ok, timestamp: 0 },
      { ...ok, timestamp: -5 },
      { ...ok, timestamp: new Date(NOW) },
      { ...ok, accuracyM: -1 },
      { ...ok, accuracyM: Number.NaN },
      { ...ok, accuracyM: Number.POSITIVE_INFINITY },
      { ...ok, accuracyM: '10' },
    ];
    for (const fix of broken) expect(normalizeFix(fix, NOW)).toBeUndefined();
  });

  it('drops only the speed or accuracy when it is missing or not a number', () => {
    expect(normalizeFix({ ...ok, speedMps: Number.POSITIVE_INFINITY }, NOW)).toStrictEqual({ lat: ok.lat, lon: ok.lon, timestamp: ok.timestamp, accuracyM: 10 });
    expect(normalizeFix({ ...ok, speedMps: Number.NaN }, NOW)?.speedMps).toBeUndefined();
    expect(normalizeFix({ ...ok, speedMps: null }, NOW)).toStrictEqual({ lat: ok.lat, lon: ok.lon, timestamp: ok.timestamp, accuracyM: 10 });
    expect(normalizeFix({ ...ok, accuracyM: null }, NOW)).toStrictEqual({ lat: ok.lat, lon: ok.lon, timestamp: ok.timestamp, speedMps: 3 });
    // A negative speed means "unknown" and is left for the ETA estimator to skip.
    expect(normalizeFix({ ...ok, speedMps: -1 }, NOW)?.speedMps).toBe(-1);
  });
});

describe('elapsedMs', () => {
  it('is the time since, or "very long" when the clock was set back beyond the tolerance', () => {
    expect(elapsedMs(NOW - 5000, NOW)).toBe(5000);
    expect(elapsedMs(NOW + 2000, NOW)).toBe(-2000);
    expect(elapsedMs(NOW + HOUR, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(elapsedMs(Number.NEGATIVE_INFINITY, NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});
