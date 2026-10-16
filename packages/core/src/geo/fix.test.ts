import { describe, expect, it } from 'vitest';
import { CLOCK_TOLERANCE_MS, elapsedMs, normalizeFix, normalizeFixes } from './fix';

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

describe('normalizeFixes', () => {
  const at = (timestamp: number, lat = ok.lat) => ({ ...ok, lat, timestamp });

  it('passes an ordinary batch through as it is', () => {
    const batch = [at(NOW - 3 * 60_000), at(NOW - 60_000), at(NOW + 30_000)];
    const out = normalizeFixes(batch, NOW);
    expect(out).toHaveLength(3);
    out.forEach((f, i) => expect(f).toBe(batch[i]));
  });

  it('moves a batch dated in the future back as a whole, so its newest fix is now and the spacing stays', () => {
    const batch = [1, 2, 3, 4, 5].map((i) => at(NOW + HOUR + i * 60_000, 52 + i / 100));
    const out = normalizeFixes(batch, NOW);
    expect(out.map((f) => f.timestamp)).toEqual([4, 3, 2, 1, 0].map((i) => NOW - i * 60_000));
    expect(out.map((f) => f.lat)).toEqual(batch.map((f) => f.lat));
    // A batch of one is the same as normalizeFix.
    expect(normalizeFixes([at(NOW + HOUR)], NOW)).toEqual([normalizeFix(at(NOW + HOUR), NOW)]);
  });

  it('keeps a batch whose newest fix is only a few seconds ahead', () => {
    const batch = [at(NOW - 60_000), at(NOW + CLOCK_TOLERANCE_MS)];
    expect(normalizeFixes(batch, NOW).map((f) => f.timestamp)).toEqual([NOW - 60_000, NOW + CLOCK_TOLERANCE_MS]);
  });

  it('drops broken fixes, and those the move would push before 1970, without throwing', () => {
    const batch = [null, at(Number.NaN), { ...ok, lat: 95 }, at(1), at(NOW + HOUR)] as unknown[];
    expect(normalizeFixes(batch, NOW)).toEqual([{ ...ok, timestamp: NOW }]);
    expect(normalizeFixes(undefined as unknown as unknown[], NOW)).toEqual([]);
    expect(normalizeFixes([], NOW)).toEqual([]);
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
