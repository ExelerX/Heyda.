import { describe, expect, it } from 'vitest';
import type { LocationFix } from './geo/types';
import { SocialNode } from './node';
import type { AppMessage } from './protocol/messages';
import { createInitialState, type NodeState } from './state';
import { MemoryNetwork } from './transport/memory';

/**
 * Regression tests: location handling must survive fixes dated in the future (GPS time vs a
 * clock set back by hand), a system clock that jumps back, and broken fixes, without
 * freezing until the app restarts. Each test first reproduced the problem.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });
const RELAY = ['wss://relay.example'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function state(key: string, name: string): NodeState {
  return createInitialState({ key, name, relays: RELAY, deviceId: `dev-${name}-00`, deviceName: `${name}s Handy` });
}

const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

/** Lisa and Max share one controllable clock; `tick` with a negative value sets it back. */
async function pairedPair() {
  let clock = 12 * HOUR;
  const now = () => clock;
  const net = new MemoryNetwork();
  const make = (key: string, name: string) =>
    new SocialNode({ transport: net.createTransport(key, now), initialState: state(key, name), now, localTime, syncDelayMs: 0 });
  const lisa = make(LISA, 'Lisa');
  const max = make(MAX, 'Max');
  await lisa.start();
  await max.start();
  await lisa.acceptInvite(max.createInvite());
  await flush();
  // What Lisa sent, checked on the wire: Max's side has its own ordering rules for her messages.
  const sent = <T extends AppMessage['type']>(type: T) =>
    net.log.filter((l) => l.from === LISA && l.message.type === type).map((l) => l.message as Extract<AppMessage, { type: T }>);
  return { net, lisa, max, now, tick: (ms: number) => (clock += ms), sent };
}

const lats = (points: ({ lat: number } | undefined)[]) => points.map((p) => (p ? Number(p.lat.toFixed(6)) : undefined));
const at = (meters: number) => Number(north(meters).lat.toFixed(6));

describe('SocialNode: location fixes with odd timestamps', () => {
  it('takes a fix dated in the future as "now" and keeps taking later fixes', async () => {
    const { lisa, now, tick, sent } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    // GPS time is an hour ahead of the phone's clock.
    await lisa.onLocationFix({ ...north(200), timestamp: now() + HOUR, accuracyM: 10 });
    expect(lisa.freshFix()?.timestamp).toBe(now());

    tick(30_000);
    await lisa.onLocationFix({ ...north(400), timestamp: now(), accuracyM: 10 });
    expect(lisa.freshFix()?.lat).toBeCloseTo(north(400).lat, 6);
    expect(lats(sent('live.update').map((m) => m.point))).toEqual([at(200), at(400)]);
  });

  it('keeps a fix a few seconds ahead as it is', async () => {
    const { lisa, now, tick } = await pairedPair();
    await lisa.onLocationFix({ ...north(200), timestamp: now() + 30_000, accuracyM: 10 });
    expect(lisa.freshFix()?.timestamp).toBe(now() + 30_000);
    tick(30_000 + 2 * MIN);
    expect(lisa.freshFix()).toBeUndefined();
  });

  it('keeps sending live updates after the clock jumps back', async () => {
    const { lisa, now, tick, sent } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await lisa.onLocationFix({ ...north(200), timestamp: now(), accuracyM: 10 });

    tick(-2 * HOUR); // the clock is set back
    await lisa.onLocationFix({ ...north(400), timestamp: now(), accuracyM: 10 });
    expect(lisa.freshFix()?.lat).toBeCloseTo(north(400).lat, 6);
    // From here on the normal pace applies again: not before 15 s ...
    tick(5_000);
    await lisa.onLocationFix({ ...north(600), timestamp: now(), accuracyM: 10 });
    // ... but then as usual.
    tick(30_000);
    await lisa.onLocationFix({ ...north(800), timestamp: now(), accuracyM: 10 });
    expect(lats(sent('live.update').map((m) => m.point))).toEqual([at(200), at(400), at(800)]);
  });

  it('still drops a fix that is merely out of order', async () => {
    const { lisa, now, tick } = await pairedPair();
    await lisa.onLocationFix({ ...north(200), timestamp: now(), accuracyM: 10 });
    tick(30_000);
    await lisa.onLocationFix({ ...north(400), timestamp: now(), accuracyM: 10 });
    await lisa.onLocationFix({ ...north(300), timestamp: now() - 10_000, accuracyM: 10 });
    expect(lisa.freshFix()?.lat).toBeCloseTo(north(400).lat, 6);
  });

  it('does not offer a fix from the future as fresh after the clock went back', async () => {
    const { lisa, max, now, tick } = await pairedPair();
    await lisa.onLocationFix({ ...north(200), timestamp: now(), accuracyM: 10 });
    expect(lisa.freshFix()).toBeDefined();

    tick(-HOUR);
    expect(lisa.freshFix()).toBeUndefined();
    expect(lisa.freshFix(DAY)).toBeUndefined();
    // So a "where are you?" is not answered with it either.
    await max.askWhere(LISA);
    await flush();
    const req = lisa.getState().whereInbox[0]!;
    await expect(lisa.answerWhere(MAX, req.requestId, { kind: 'precise' })).rejects.toThrow(/nicht bekannt/);

    // A new fix works right away.
    await lisa.onLocationFix({ ...north(300), timestamp: now(), accuracyM: 10 });
    expect(lisa.freshFix()?.lat).toBeCloseTo(north(300).lat, 6);
  });

  it('drops broken fixes without throwing', async () => {
    const { lisa, now } = await pairedPair();
    const t = now();
    const broken: unknown[] = [
      null,
      undefined,
      'here',
      {},
      { lat: Number.NaN, lon: 13.4, timestamp: t },
      { lat: 91, lon: 13.4, timestamp: t },
      { lat: 52.5, lon: -181, timestamp: t },
      { lat: '52.5', lon: 13.4, timestamp: t },
      { ...home },
      { ...home, timestamp: Number.NaN },
      { ...home, timestamp: Number.POSITIVE_INFINITY },
      { ...home, timestamp: -1 },
      { ...home, timestamp: 0 },
      { ...home, timestamp: String(t) },
      { ...home, timestamp: t, accuracyM: -1 },
      { ...home, timestamp: t, accuracyM: Number.NaN },
      { ...home, timestamp: t, accuracyM: Number.POSITIVE_INFINITY },
    ];
    for (const fix of broken) await expect(lisa.onLocationFix(fix as LocationFix)).resolves.toBeUndefined();
    expect(lisa.freshFix(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('drops an impossible speed so the ETA does not get stuck', async () => {
    const { lisa, now, tick, sent } = await pairedPair();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Bei Max', destination: home, level: 'eta' });
    await lisa.onLocationFix({ ...north(5000), timestamp: now(), accuracyM: 10, speedMps: Number.POSITIVE_INFINITY });
    expect(lisa.freshFix()?.speedMps).toBeUndefined();
    tick(MIN);
    // Walking: about 70 minutes for 4.5 km.
    await lisa.onLocationFix({ ...north(4500), timestamp: now(), accuracyM: 10, speedMps: 1.4 });
    const etas = sent('session.update').flatMap((m) => (m.etaMinutes !== undefined ? [m.etaMinutes] : []));
    expect(etas.at(-1)).toBeGreaterThan(30);
  });
});

describe('SocialNode: trips and live shares when the clock jumps', () => {
  it('does not end a trip early because of a fix dated in the future', async () => {
    const { lisa, now } = await pairedPair();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino', destination: north(5000), durationMs: 30 * MIN });
    await lisa.onLocationFix({ ...north(1000), timestamp: now() + 2 * HOUR, accuracyM: 10 });
    expect(lisa.activeTrip).toBeDefined();
  });

  it('keeps sending precise trip points after the clock jumps back', async () => {
    const { lisa, now, tick, sent } = await pairedPair();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino', destination: north(20_000), level: 'precise' });
    tick(30 * MIN);
    await lisa.onLocationFix({ ...north(1000), timestamp: now(), accuracyM: 10 });
    tick(-20 * MIN); // set back, but still after the trip started
    await lisa.onLocationFix({ ...north(1500), timestamp: now(), accuracyM: 10 });
    expect(lisa.activeTrip).toBeDefined();
    expect(lats(sent('session.update').map((m) => m.point).filter(Boolean))).toEqual([at(1000), at(1500)]);
  });

  it('ends a trip on the next tick when the clock jumps back to before it started', async () => {
    const { lisa, tick, sent } = await pairedPair();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino', durationMs: 30 * MIN });
    tick(-3 * HOUR);
    await lisa.tick();
    expect(lisa.activeTrip).toBeUndefined();
    expect(sent('session.end').at(-1)).toMatchObject({ reason: 'expired' });
  });

  it('ends such a trip on the next fix too, and sends no update for it', async () => {
    const { lisa, now, tick, sent } = await pairedPair();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino', destination: north(20_000), level: 'precise' });
    tick(-3 * HOUR);
    await lisa.onLocationFix({ ...north(1000), timestamp: now(), accuracyM: 10 });
    expect(lisa.activeTrip).toBeUndefined();
    expect(sent('session.update')).toEqual([]);
    expect(sent('session.end').at(-1)).toMatchObject({ reason: 'expired' });
  });

  it('tolerates a small clock correction right after a trip started', async () => {
    const { lisa, now, tick } = await pairedPair();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino', destination: north(20_000) });
    tick(-30_000);
    await lisa.onLocationFix({ ...north(1000), timestamp: now(), accuracyM: 10 });
    await lisa.tick();
    expect(lisa.activeTrip).toBeDefined();
  });

  it('ends a timed live share when the clock jumps back to before it started', async () => {
    const { lisa, now, tick, sent } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'coarse', durationMs: HOUR });
    tick(-3 * HOUR);
    expect(lisa.locationNeeds().mode).toBe('off');
    await lisa.onLocationFix({ ...north(200), timestamp: now(), accuracyM: 10 });
    expect(sent('live.update')).toEqual([]);
    await lisa.tick();
    expect(lisa.getState().liveShares).toEqual([]);
    expect(sent('live.end').at(-1)).toMatchObject({ reason: 'expired' });
  });

  it('keeps an open-ended live share running after the clock jumps back', async () => {
    const { lisa, now, tick, sent } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    tick(-3 * HOUR);
    await lisa.tick();
    expect(lisa.getState().liveShares).toHaveLength(1);
    expect(lisa.locationNeeds().mode).toBe('high');
    await lisa.onLocationFix({ ...north(200), timestamp: now(), accuracyM: 10 });
    expect(lats(sent('live.update').map((m) => m.point))).toEqual([at(200)]);
  });

  it('still notices arriving at a place after the clock jumps back', async () => {
    const { lisa, now, tick, sent } = await pairedPair();
    lisa.setPlaces([{ id: 'home', name: 'Zuhause', center: home, radiusM: 100 }]);
    lisa.setGrants([{ contactKey: MAX, placeIds: ['home'] }]);
    await lisa.onLocationFix({ ...north(500), timestamp: now(), accuracyM: 10 }); // starts outside, silent
    tick(10_000);
    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 }); // inside, waiting a minute
    tick(-HOUR);
    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 });
    tick(61_000);
    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 });
    expect(sent('place.event').map((m) => m.kind)).toEqual(['arrive']);
  });
});
