import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './automation/templates';
import type { LocationFix } from './geo/types';
import { SocialNode } from './node';
import { serializeAppMessage, type AppMessage } from './protocol/messages';
import { createInitialState, type NodeState } from './state';
import { MemoryNetwork, MemoryTransport } from './transport/memory';
import type { SendOptions } from './transport/transport';

/**
 * Regression tests: location handling must survive fixes dated in the future (GPS time vs a
 * clock set back by hand), a system clock that jumps back, and broken fixes, without
 * freezing until the app restarts. The same goes for what contacts send me and for my outbox
 * after my clock jumps back. Each test first reproduced the problem (the "still ..." ones
 * guard behaviour that must not change).
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

/** Like `pairedPair`, but Max has his own clock, so only his can jump. */
async function pairWithOwnClocks() {
  let lisaClock = 12 * HOUR;
  let maxClock = 12 * HOUR;
  const lisaNow = () => lisaClock;
  const maxNow = () => maxClock;
  const net = new MemoryNetwork();
  const lisa = new SocialNode({ transport: net.createTransport(LISA, lisaNow), initialState: state(LISA, 'Lisa'), now: lisaNow, localTime, syncDelayMs: 0 });
  const max = new SocialNode({ transport: net.createTransport(MAX, maxNow), initialState: state(MAX, 'Max'), now: maxNow, localTime, syncDelayMs: 0 });
  await lisa.start();
  await max.start();
  await lisa.acceptInvite(max.createInvite());
  await flush();
  /** Time passes for both; `maxJump` additionally moves only Max's clock. */
  const tick = (ms: number, maxJump = 0) => {
    lisaClock += ms;
    maxClock += ms + maxJump;
  };
  return { net, lisa, max, lisaNow, tick };
}

describe('SocialNode: what contacts send, after my clock jumps back', () => {
  it('still drops an update a relay delivers late while the clocks agree', async () => {
    const { net, lisa, max, lisaNow, tick } = await pairWithOwnClocks();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await lisa.onLocationFix({ ...north(200), timestamp: lisaNow(), accuracyM: 10 });
    tick(30_000);
    await lisa.onLocationFix({ ...north(400), timestamp: lisaNow(), accuracyM: 10 });
    await flush();
    const first = net.log.find((l) => l.from === LISA && l.message.type === 'live.update')!.message;
    net.deliver(LISA, MAX, serializeAppMessage({ ...first, id: 'late-copy-0001' }));
    await flush();
    expect(max.getStatus(LISA).live?.point?.lat).toBeCloseTo(north(400).lat, 6);
  });

  it('keeps showing their live location', async () => {
    const { lisa, max, lisaNow, tick } = await pairWithOwnClocks();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await lisa.onLocationFix({ ...north(200), timestamp: lisaNow(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).live?.point?.lat).toBeCloseTo(north(200).lat, 6);

    tick(30_000, -2 * HOUR); // Max's clock is set back
    await lisa.onLocationFix({ ...north(400), timestamp: lisaNow(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).live?.point?.lat).toBeCloseTo(north(400).lat, 6);

    // And the order of her updates still counts from here on.
    tick(30_000);
    await lisa.onLocationFix({ ...north(600), timestamp: lisaNow(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).live?.point?.lat).toBeCloseTo(north(600).lat, 6);
  });

  it('keeps showing their trip', async () => {
    const { lisa, max, lisaNow, tick } = await pairWithOwnClocks();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino', destination: north(20_000), level: 'precise' });
    await lisa.onLocationFix({ ...north(1000), timestamp: lisaNow(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).trip?.point?.lat).toBeCloseTo(north(1000).lat, 6);

    tick(MIN, -2 * HOUR);
    await lisa.onLocationFix({ ...north(2000), timestamp: lisaNow(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).trip?.point?.lat).toBeCloseTo(north(2000).lat, 6);
  });

  it('keeps showing where someone in need is', async () => {
    const { lisa, max, lisaNow, tick } = await pairWithOwnClocks();
    lisa.updateContact(MAX, { emergency: true });
    await lisa.onLocationFix({ ...north(200), timestamp: lisaNow(), accuracyM: 10 });
    await lisa.startSos();
    await flush();
    expect(max.getStatus(LISA).sos?.point?.lat).toBeCloseTo(north(200).lat, 6);

    tick(30_000, -2 * HOUR);
    await lisa.onLocationFix({ ...north(400), timestamp: lisaNow(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).sos?.point?.lat).toBeCloseTo(north(400).lat, 6);
  });

  it('keeps showing their status', async () => {
    const { lisa, max, tick } = await pairWithOwnClocks();
    await lisa.setMyStatus({ text: 'Beim Sport', hours: 2 });
    await flush();
    expect(max.getStatus(LISA).presence?.status?.text).toBe('Beim Sport');

    tick(MIN, -2 * HOUR);
    await lisa.setMyStatus({ text: 'In der Uni', hours: 2 });
    await flush();
    expect(max.getStatus(LISA).presence?.status?.text).toBe('In der Uni');
  });
});

class FlakyTransport extends MemoryTransport {
  offline = false;
  override async send(to: string, message: AppMessage, options?: SendOptions): Promise<void> {
    if (this.offline) throw new Error('offline');
    return super.send(to, message, options);
  }
}

describe('SocialNode: a contact whose fast clock gets corrected', () => {
  /** Lisa's clock can run apart from Max's; `tick(ms, lisaJump)` moves both, Lisa's by more. */
  async function skewedPair() {
    let maxClock = 10 * DAY + 12 * HOUR;
    let lisaClock = maxClock;
    const net = new MemoryNetwork();
    const lisaNow = () => lisaClock;
    const maxNow = () => maxClock;
    const lisa = new SocialNode({ transport: net.createTransport(LISA, lisaNow), initialState: state(LISA, 'Lisa'), now: lisaNow, localTime, syncDelayMs: 0 });
    const max = new SocialNode({ transport: net.createTransport(MAX, maxNow), initialState: state(MAX, 'Max'), now: maxNow, localTime, syncDelayMs: 0 });
    await lisa.start();
    await max.start();
    await lisa.acceptInvite(max.createInvite());
    await flush();
    const tick = (ms: number, lisaJump = 0) => {
      maxClock += ms;
      lisaClock += ms + lisaJump;
    };
    return { lisa, max, lisaNow, tick };
  }

  it('takes her SOS location again right after her clock is corrected', async () => {
    const { lisa, max, lisaNow, tick } = await skewedPair();
    tick(0, 2 * HOUR); // her phone clock runs 2 h fast
    lisa.updateContact(MAX, { emergency: true });
    await lisa.onLocationFix({ ...north(200), timestamp: lisaNow(), accuracyM: 10 });
    await lisa.startSos();
    await flush();
    expect(max.getStatus(LISA).sos?.point?.lat).toBeCloseTo(north(200).lat, 6);

    tick(30_000, -2 * HOUR); // network time corrects it
    await lisa.onLocationFix({ ...north(400), timestamp: lisaNow(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).sos?.point?.lat).toBeCloseTo(north(400).lat, 6);
  });

  it('still ignores a late update while her clock is only a little ahead', async () => {
    const { lisa, max, lisaNow, tick } = await skewedPair();
    tick(0, 20_000); // 20 s ahead, as phones often are
    await lisa.onLocationFix({ ...north(0), timestamp: lisaNow(), accuracyM: 10 });
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await flush();
    const share = max.getStatus(LISA).live!;
    // A relay hands Max an update from before the one he already has.
    const late = { type: 'live.update', shareId: share.shareId, point: { ...north(50), accuracyM: 10 }, sentAt: lisaNow() - 5 * MIN };
    await (max as unknown as { handleIncoming: (m: unknown) => Promise<void> }).handleIncoming({ from: LISA, message: { ...late, id: 'late-1' } });
    expect(max.getStatus(LISA).live?.point?.lat).toBeCloseTo(north(0).lat, 6);
  });
});

describe('SocialNode: the outbox when the clock jumps back', () => {
  it('retries right away instead of waiting for the clock to catch up, within the time limit', async () => {
    let clock = DAY;
    const now = () => clock;
    const net = new MemoryNetwork();
    const flaky = new FlakyTransport(net, LISA, now);
    const lisa = new SocialNode({ transport: flaky, initialState: state(LISA, 'Lisa'), now, localTime, syncDelayMs: 0 });
    const max = new SocialNode({ transport: net.createTransport(MAX, now), initialState: state(MAX, 'Max'), now, localTime, syncDelayMs: 0 });
    await lisa.start();
    await max.start();
    await lisa.acceptInvite(max.createInvite());
    await flush();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });

    flaky.offline = true;
    await lisa.onLocationFix({ ...north(200), timestamp: now(), accuracyM: 10 });
    expect(lisa.getState().outbox.map((e) => e.message.type)).toEqual(['live.update']);

    clock -= 2 * HOUR;
    flaky.offline = false;
    await lisa.tick();
    await flush();
    expect(lisa.getState().outbox).toEqual([]);
    const sent = net.log.filter((l) => l.from === LISA && l.message.type === 'live.update');
    expect(sent).toHaveLength(1);
    // Relays keep it no longer than any live update.
    expect(sent[0]!.options?.ttlSeconds).toBeLessThanOrEqual(3600);
    expect(max.getStatus(LISA).live?.point?.lat).toBeCloseTo(north(200).lat, 6);
  });

  it('still waits between retries while the clock runs normally', async () => {
    let clock = DAY;
    const now = () => clock;
    const net = new MemoryNetwork();
    const flaky = new FlakyTransport(net, LISA, now);
    const lisa = new SocialNode({ transport: flaky, initialState: state(LISA, 'Lisa'), now, localTime, syncDelayMs: 0 });
    const max = new SocialNode({ transport: net.createTransport(MAX, now), initialState: state(MAX, 'Max'), now, localTime, syncDelayMs: 0 });
    await lisa.start();
    await max.start();
    await lisa.acceptInvite(max.createInvite());
    await flush();
    flaky.offline = true;
    await lisa.sendChat(MAX, 'kommt später an');
    flaky.offline = false;
    clock += 5_000;
    await lisa.tick();
    expect(lisa.getState().outbox).toHaveLength(1);
    clock += 15_000;
    await lisa.tick();
    expect(lisa.getState().outbox).toEqual([]);
  });
});

describe('SocialNode: a restart after the clock was set back', () => {
  it('tells the recipients that a trip the clock went back before is over', async () => {
    const { net, lisa, max, now, tick, sent } = await pairedPair();
    const session = await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino' });
    await flush();
    expect(max.getStatus(LISA).trip).toBeDefined();

    await lisa.stop();
    tick(-3 * HOUR);
    const relaunched = new SocialNode({ transport: net.createTransport(LISA, now), initialState: lisa.getState(), now, localTime, syncDelayMs: 0 });
    await relaunched.start();
    // Not picked up again (the app forgets it), but not dropped silently either.
    expect(relaunched.resumeTrip(session)).toBe(false);
    expect(relaunched.activeTrip).toBeUndefined();
    expect(relaunched.locationNeeds().reasons).not.toContain('trip');
    await flush();
    expect(sent('session.end')).toMatchObject([{ sessionId: session.id, reason: 'expired' }]);
    expect(max.getStatus(LISA).trip).toBeUndefined();
  });

  it('still sends nothing for a trip that simply ran out while the app was closed', async () => {
    const { net, lisa, now, tick, sent } = await pairedPair();
    const session = await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino', durationMs: 30 * MIN });
    await lisa.stop();
    tick(HOUR);
    const relaunched = new SocialNode({ transport: net.createTransport(LISA, now), initialState: lisa.getState(), now, localTime, syncDelayMs: 0 });
    await relaunched.start();
    expect(relaunched.resumeTrip(session)).toBe(false);
    await flush();
    expect(sent('session.end')).toEqual([]);
  });

  it('still resumes a trip after a small clock correction, without announcing anything', async () => {
    const { net, lisa, now, tick, sent } = await pairedPair();
    const session = await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino' });
    await lisa.stop();
    tick(-30_000);
    const relaunched = new SocialNode({ transport: net.createTransport(LISA, now), initialState: lisa.getState(), now, localTime, syncDelayMs: 0 });
    await relaunched.start();
    expect(relaunched.resumeTrip(session)).toBe(true);
    await flush();
    expect(sent('session.end')).toEqual([]);
    expect(sent('session.start')).toHaveLength(1);
  });
});

describe('SocialNode: SOS location when the clock jumps back', () => {
  async function withSos() {
    const pair = await pairedPair();
    pair.lisa.updateContact(MAX, { emergency: true });
    await pair.lisa.onLocationFix({ ...north(100), timestamp: pair.now(), accuracyM: 10 });
    await pair.lisa.startSos();
    return pair;
  }

  it('keeps the rest of the hour, no more, when the clock is set back while the app runs', async () => {
    const { lisa, now, tick, sent } = await withSos();
    expect(lisa.locationNeeds()).toEqual({ mode: 'high', reasons: ['sos'] });
    tick(10 * MIN);
    await lisa.tick();
    tick(-3 * HOUR); // e.g. a wrong clock that network time corrects
    // A person in need keeps sending where they are ...
    expect(lisa.locationNeeds()).toEqual({ mode: 'high', reasons: ['sos'] });
    await lisa.onLocationFix({ ...north(500), timestamp: now(), accuracyM: 10 });
    expect(lats(sent('sos.update').map((m) => m.point))).toEqual([at(500)]);
    // ... for the 50 minutes that were left, not for three more hours.
    tick(51 * MIN);
    await lisa.tick();
    expect(lisa.locationNeeds()).toEqual({ mode: 'off', reasons: [] });
    await lisa.onLocationFix({ ...north(900), timestamp: now(), accuracyM: 10 });
    expect(lats(sent('sos.update').map((m) => m.point))).toEqual([at(500)]);
    expect(lisa.getState().sos).toBeDefined(); // the alert itself stays open
  });

  it('also in ghost mode', async () => {
    const { lisa, now, tick, sent } = await withSos();
    await lisa.setGhost(true);
    tick(-3 * HOUR);
    await lisa.tick();
    tick(61 * MIN);
    expect(lisa.locationNeeds().reasons).toEqual([]);
    await lisa.onLocationFix({ ...north(500), timestamp: now(), accuracyM: 10 });
    expect(sent('sos.update')).toEqual([]);
  });

  it('starts a new hour when I press SOS again after the clock went back', async () => {
    const { lisa, now, tick, sent } = await withSos();
    tick(-3 * HOUR);
    await lisa.startSos();
    expect(lisa.locationNeeds().reasons).toEqual(['sos']);
    tick(MIN);
    await lisa.onLocationFix({ ...north(500), timestamp: now(), accuracyM: 10 });
    expect(lats(sent('sos.update').map((m) => m.point))).toEqual([at(500)]);
  });

  it('still sends my location for the hour, through a clock set back within it', async () => {
    const { lisa, now, tick, sent } = await withSos();
    tick(40 * MIN);
    await lisa.onLocationFix({ ...north(500), timestamp: now(), accuracyM: 10 });
    tick(-30 * MIN); // still after the SOS started
    expect(lisa.locationNeeds().reasons).toEqual(['sos']);
    await lisa.onLocationFix({ ...north(900), timestamp: now(), accuracyM: 10 });
    tick(51 * MIN); // an hour and a minute after the SOS by the clock
    await lisa.onLocationFix({ ...north(1300), timestamp: now(), accuracyM: 10 });
    expect(lats(sent('sos.update').map((m) => m.point))).toEqual([at(500), at(900)]);
    expect(lisa.locationNeeds().reasons).toEqual([]);
  });
});

describe('SocialNode: automations when fixes arrive late', () => {
  it('sends the "arrived" check-in once when a late batch of fixes reports the same arrival', async () => {
    const { lisa, now, sent } = await pairedPair();
    lisa.setPlaces([{ id: 'home', name: 'Zuhause', center: home, radiusM: 100 }]);
    const made = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === 'core.home-safe')!, { myplace: 'home', contact: MAX });
    if (!made.ok) throw new Error('template');
    lisa.setRules([made.value]);
    lisa.syncPlaceState('home', false);
    await lisa.onLocationFix({ ...north(2000), timestamp: now() - 10 * MIN, accuracyM: 10 });
    // The OS region monitor reports the arrival right away, with my clock ...
    await lisa.onPlaceTransition('home', 'arrive');
    // ... and the fixes of the last minutes come later, with their own (older) times.
    const N = now();
    for (const [ago, meters] of [[200_000, 500], [150_000, 0], [80_000, 0]] as const) {
      await lisa.onLocationFix({ ...north(meters), timestamp: N - ago, accuracyM: 10 });
    }
    await flush();
    expect(sent('checkin')).toHaveLength(1);
  });
});

describe('SocialNode: a batch of fixes dated in the future', () => {
  /** Live sharing, one fix, and five minutes later a batch of five fixes a minute apart, all `skew` ahead. */
  async function batch(skew: number) {
    const { lisa, now, tick, sent } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await lisa.onLocationFix({ ...north(0), timestamp: now() + skew, accuracyM: 10 });
    tick(5 * MIN);
    const newest = now() + skew;
    await lisa.onLocationFixes([1000, 2000, 3000, 4000, 5000].map((m, i) => ({ ...north(m), timestamp: newest - (4 - i) * MIN, accuracyM: 10 })));
    return { lisa, now, sent };
  }

  it('sends every position of the batch up to the newest, as with a correct clock', async () => {
    const right = await batch(0);
    const ahead = await batch(HOUR);
    const expected = [at(0), at(1000), at(2000), at(3000), at(4000), at(5000)];
    expect(lats(right.sent('live.update').map((m) => m.point))).toEqual(expected);
    expect(lats(ahead.sent('live.update').map((m) => m.point))).toEqual(expected);
    // The newest fix of the batch counts as now.
    expect(ahead.lisa.freshFix()?.timestamp).toBe(ahead.now());
    expect(ahead.lisa.freshFix()?.lat).toBeCloseTo(north(5000).lat, 6);
  });

  it('drops the broken fixes of a batch without throwing', async () => {
    const { lisa, now, sent } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    const broken = [{ ...north(100), timestamp: Number.NaN }, null, { lat: 91, lon: 0, timestamp: now() }] as unknown as LocationFix[];
    await expect(lisa.onLocationFixes([...broken, { ...north(300), timestamp: now(), accuracyM: 10 }])).resolves.toBeUndefined();
    await expect(lisa.onLocationFixes(undefined as unknown as LocationFix[])).resolves.toBeUndefined();
    expect(lats(sent('live.update').map((m) => m.point))).toEqual([at(300)]);
  });
});
