import { describe, expect, it } from 'vitest';
import { isLiveShareActive, LIVE_CADENCE, LiveTracker } from './live';

const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });
const T = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const fix = (meters: number, timestamp: number) => ({ ...north(meters), timestamp, accuracyM: 10 });

describe('LiveTracker', () => {
  it('sends on movement or a heartbeat, but not more often than the minimum interval', () => {
    const t = new LiveTracker();
    expect(t.precise(fix(0, T))).toBeDefined();
    expect(t.precise(fix(100, T + 5_000))).toBeUndefined();
    expect(t.precise(fix(100, T + 20_000))).toBeDefined();
    expect(t.precise(fix(105, T + MIN))).toBeUndefined(); // barely moved
    expect(t.precise(fix(105, T + 20_000 + LIVE_CADENCE.heartbeatMs))).toBeDefined();
  });

  it('treats a clock that jumped back as "interval elapsed", not as "wait until it catches up"', () => {
    const t = new LiveTracker();
    expect(t.precise(fix(0, T))).toBeDefined();
    expect(t.precise(fix(0, T - 2 * HOUR))).toBeDefined();
    // The normal pace continues from the new time.
    expect(t.precise(fix(100, T - 2 * HOUR + 5_000))).toBeUndefined();
    expect(t.precise(fix(100, T - 2 * HOUR + 20_000))).toBeDefined();
  });

  it('keeps the pace through a few seconds of jitter between fix clocks', () => {
    const t = new LiveTracker();
    expect(t.precise(fix(0, T))).toBeDefined();
    expect(t.precise(fix(100, T - 2_000))).toBeUndefined();
    expect(t.precise(fix(100, T + 20_000))).toBeDefined();
  });

  it('ignores a fix without a usable time, so the pace is not lost', () => {
    const t = new LiveTracker();
    expect(t.precise(fix(0, T))).toBeDefined();
    expect(t.precise(fix(100, Number.NaN))).toBeUndefined();
    expect(t.precise(fix(100, T + 5_000))).toBeUndefined();
    expect(t.precise(fix(100, T + 20_000))).toBeDefined();
    expect(t.cell(fix(0, T))).toBeDefined();
    expect(t.cell(fix(5000, Number.NaN))).toBeUndefined();
    expect(t.cell(fix(0, T + MIN))).toBeUndefined();
  });

  it('counts a timed share as over before its start, an open-ended one never', () => {
    const timed = { startedAt: T, expiresAt: T + HOUR };
    expect(isLiveShareActive(timed, T)).toBe(true);
    expect(isLiveShareActive(timed, T - 30_000)).toBe(true); // small clock correction
    expect(isLiveShareActive(timed, T - 2 * HOUR)).toBe(false);
    expect(isLiveShareActive(timed, T + HOUR)).toBe(false);
    expect(isLiveShareActive({ startedAt: T }, T - DAY)).toBe(true);
    expect(isLiveShareActive({ startedAt: T }, T + 30 * DAY)).toBe(true);
  });

  it('resends the coarse cell after the clock jumped back', () => {
    const t = new LiveTracker();
    expect(t.cell(fix(0, T))).toBeDefined();
    expect(t.cell(fix(0, T + MIN))).toBeUndefined();
    expect(t.cell(fix(0, T - DAY))).toBeDefined();
    expect(t.cell(fix(0, T - DAY + MIN))).toBeUndefined();
    expect(t.cell(fix(0, T - DAY + LIVE_CADENCE.coarseHeartbeatMs))).toBeDefined();
  });
});
