import { describe, expect, it } from 'vitest';
import { createSession, isSessionActive } from './session';
import { TripSharer } from './trip';

const A = 'a'.repeat(64);
const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });
const T = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const fix = (meters: number, timestamp: number) => ({ ...north(meters), timestamp, accuracyM: 10 });

const preciseTrip = (durationMs = 2 * HOUR) =>
  new TripSharer(createSession({ recipients: [A], destinationName: 'Kino', level: 'precise', durationMs, now: T }));

const hasPoint = (bodies: unknown[]) => bodies.some((b) => (b as { point?: unknown }).point !== undefined);

describe('TripSharer and the clock', () => {
  it('sends precise points again after the clock jumped back', () => {
    const trip = preciseTrip();
    expect(hasPoint(trip.onFix(fix(0, T + HOUR)))).toBe(true);
    expect(hasPoint(trip.onFix(fix(100, T + HOUR + 10_000)))).toBe(false); // within 30 s
    // Set back by 50 minutes: before, no point went out until the clock caught up.
    expect(hasPoint(trip.onFix(fix(200, T + 10 * MIN)))).toBe(true);
    expect(hasPoint(trip.onFix(fix(300, T + 10 * MIN + 10_000)))).toBe(false);
    expect(hasPoint(trip.onFix(fix(300, T + 10 * MIN + 30_000)))).toBe(true);
  });

  it('keeps the pace through a few seconds of jitter between fix clocks', () => {
    const trip = preciseTrip();
    expect(hasPoint(trip.onFix(fix(0, T + MIN)))).toBe(true);
    expect(hasPoint(trip.onFix(fix(100, T + MIN - 2_000)))).toBe(false);
  });

  it('is not ended by an old fix taken before it started', () => {
    const trip = preciseTrip();
    trip.onFix(fix(0, T - HOUR));
    expect(trip.isEnded).toBe(false);
  });

  it('still ends at its end time', () => {
    const trip = preciseTrip(30 * MIN);
    expect(trip.onFix(fix(0, T + 30 * MIN))).toEqual([{ type: 'session.end', sessionId: trip.session.id, reason: 'expired' }]);
  });

  it('expires when the clock jumps back to before it started', () => {
    const trip = preciseTrip(30 * MIN);
    expect(trip.expire(T + MIN)).toEqual([]);
    expect(trip.expire(T - 30_000)).toEqual([]); // a small correction is fine
    expect(trip.expire(T - HOUR)).toEqual([{ type: 'session.end', sessionId: trip.session.id, reason: 'expired' }]);
    expect(trip.endReason).toBe('expired');
  });
});

describe('isSessionActive', () => {
  it('runs from its start (with a little slack) to its end', () => {
    const s = createSession({ recipients: [A], destinationName: 'Kino', durationMs: HOUR, now: T });
    expect(isSessionActive(s, T)).toBe(true);
    expect(isSessionActive(s, T - 30_000)).toBe(true);
    expect(isSessionActive(s, T - HOUR)).toBe(false);
    expect(isSessionActive(s, T + HOUR - 1)).toBe(true);
    expect(isSessionActive(s, T + HOUR)).toBe(false);
    expect(isSessionActive({ ...s, endedAt: T + 1 }, T + 2)).toBe(false);
  });
});
