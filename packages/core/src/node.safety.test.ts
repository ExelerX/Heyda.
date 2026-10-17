import { describe, expect, it } from 'vitest';
import { SocialNode, type NodeEvent } from './node';
import type { AppMessage, AppMessageBody } from './protocol/messages';
import { createInitialState, type Alert, type NodeState } from './state';
import { MemoryNetwork, MemoryTransport } from './transport/memory';
import type { SendOptions } from './transport/transport';

/**
 * Regression tests for the safety features when messages come late or out of order (relays hand
 * stored messages over in any order), for how loud watch and SOS alarms are, and for the outbox
 * after being offline. Each one first reproduced the problem before it was fixed.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const MIA = '4'.repeat(64);
const TOM = '6'.repeat(64);
const BEN = '7'.repeat(64);
const RELAY = ['wss://relay.example'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function state(key: string, name: string): NodeState {
  return createInitialState({ key, name, relays: RELAY, deviceId: `dev-${name}-00`, deviceName: `${name}s Handy` });
}

const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

/** Sending fails while offline, and always to the people in `dead` (say their relay is gone). */
class SelectiveTransport extends MemoryTransport {
  offline = false;
  readonly dead = new Set<string>();
  readonly attempts: string[] = [];
  override async send(to: string, message: AppMessage, options?: SendOptions): Promise<void> {
    this.attempts.push(to);
    if (this.offline || this.dead.has(to)) throw new Error('offline');
    return super.send(to, message, options);
  }
}

function world() {
  let clock = 12 * HOUR;
  const now = () => clock;
  const net = new MemoryNetwork();
  const make = (key: string, name: string, opts: { transport?: MemoryTransport } = {}) =>
    new SocialNode({ transport: opts.transport ?? net.createTransport(key, now), initialState: state(key, name), now, localTime, syncDelayMs: 0 });
  const pair = async (a: SocialNode, b: SocialNode) => {
    await a.acceptInvite(b.createInvite());
    await flush();
  };
  /** Sends a hand-made message as `from`, with the sender's clock at `sentAt`. */
  const forge = (from: string) => {
    const t = net.createTransport(from, now);
    let n = 0;
    return async (to: string, body: AppMessageBody, sentAt = clock) => {
      await t.send(to, { ...body, v: 1, id: `forged-${from.slice(0, 4)}-${String(n++).padStart(6, '0')}`, sentAt } as AppMessage);
      await flush();
    };
  };
  return { net, now, tick: (ms: number) => (clock += ms), make, pair, forge };
}

/** Lisa and Max; Max's transport is kept so a test can hold back or reorder what reaches him. */
async function pairedPair() {
  const w = world();
  const maxT = w.net.createTransport(MAX, w.now);
  const lisa = w.make(LISA, 'Lisa');
  const max = w.make(MAX, 'Max', { transport: maxT });
  await lisa.start();
  await max.start();
  await w.pair(lisa, max);
  return { ...w, lisa, max, maxT };
}

function alerts(node: SocialNode): Alert[] {
  const out: Alert[] = [];
  node.on((e) => e.type === 'alert' && out.push(e.alert));
  return out;
}

function events(node: SocialNode): NodeEvent[] {
  const out: NodeEvent[] = [];
  node.on((e) => out.push(e));
  return out;
}

function schedules(evs: NodeEvent[], id?: string) {
  return evs.flatMap((e) => (e.type === 'alarm.schedule' && (id === undefined || e.alarm.id === id) ? [e.alarm] : []));
}

const typeOf = (p: { raw: string }) => (JSON.parse(p.raw) as { type: string }).type;

describe('safety: SOS messages that arrive late or out of order', () => {
  it('keeps the real SOS when an older, cancelled one is caught up after it', async () => {
    const { lisa, max, maxT, tick, now } = await pairedPair();
    lisa.updateContact(MAX, { emergency: true });
    // Max is offline while Lisa presses SOS by accident, cancels it, then presses it for real.
    await max.stop();
    await lisa.startSos({ text: 'aus Versehen' });
    tick(20_000);
    await lisa.endSos('cancelled');
    tick(MIN);
    await lisa.startSos({ text: 'Hilfe, echt jetzt' });
    const real = lisa.getState().sos!.sosId;

    // Relays hand over stored messages in any order (their times are randomly backdated).
    const sos = maxT.pending.filter((p) => typeOf(p).startsWith('sos.'));
    expect(sos.map(typeOf)).toEqual(['sos.start', 'sos.end', 'sos.start']);
    const [aStart, aEnd, bStart] = sos as [(typeof sos)[0], (typeof sos)[0], (typeof sos)[0]];
    const rest = maxT.pending.filter((p) => !sos.includes(p));
    maxT.pending.splice(0, maxT.pending.length, ...rest, bStart, aStart, aEnd);

    const got = alerts(max);
    await max.start();
    await flush();
    const status = max.getStatus(LISA).sos!;
    expect(status.sosId).toBe(real);
    expect(status.text).toBe('Hilfe, echt jetzt');
    expect(status.endedAt).toBeUndefined();
    expect(got.filter((a) => a.level === 'alarm').map((a) => a.body)).toEqual(['Hilfe, echt jetzt']);
    expect(got.some((a) => a.title.includes('abgebrochen'))).toBe(false);

    // Her location for the real SOS still reaches Max, and he can say he is coming.
    tick(MIN);
    await lisa.onLocationFix({ ...north(300), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).sos!.point?.lat).toBeCloseTo(north(300).lat, 6);
    await max.ackSos(LISA, 'Bin unterwegs');
    await flush();
    expect(lisa.getState().sos!.acks.map((a) => a.key)).toEqual([MAX]);
  });

  it('does not bring back an older SOS after the newer one ended', async () => {
    const { max, now, forge } = await pairedPair();
    const send = forge(LISA);
    const got = alerts(max);
    const base = now() - HOUR;
    await send(MAX, { type: 'sos.start', sosId: 'sos-new-0001', text: 'neu', others: [] }, base + 10 * MIN);
    await send(MAX, { type: 'sos.end', sosId: 'sos-new-0001', reason: 'safe' }, base + 20 * MIN);
    await send(MAX, { type: 'sos.start', sosId: 'sos-old-0001', text: 'alt', others: [] }, base);
    await send(MAX, { type: 'sos.end', sosId: 'sos-old-0001', reason: 'cancelled' }, base + MIN);
    const status = max.getStatus(LISA).sos!;
    expect(status).toMatchObject({ sosId: 'sos-new-0001', endReason: 'safe' });
    expect(got.filter((a) => a.level === 'alarm').map((a) => a.body)).toEqual(['neu']);
  });

  it('an older copy of the same SOS does not replace a newer location', async () => {
    const { max, now, forge } = await pairedPair();
    const send = forge(LISA);
    const base = now() - HOUR;
    const newer = { ...north(500), accuracyM: 5 };
    const older = { ...north(10), accuracyM: 5 };
    await send(MAX, { type: 'sos.start', sosId: 'sos-same-001', text: 'Hilfe', point: newer, others: [] }, base + 5 * MIN);
    await send(MAX, { type: 'sos.start', sosId: 'sos-same-001', text: 'Hilfe', point: older, others: [] }, base);
    expect(max.getStatus(LISA).sos!.point?.lat).toBeCloseTo(newer.lat, 6);
    // A location update sent between the two still counts.
    await send(MAX, { type: 'sos.update', sosId: 'sos-same-001', point: older }, base + 6 * MIN);
    expect(max.getStatus(LISA).sos!.point?.lat).toBeCloseTo(older.lat, 6);
  });

  it('pressing SOS again with a new text and helper still counts when a location update overtook it', async () => {
    const { max, now, forge } = await pairedPair();
    const send = forge(LISA);
    const base = now() - HOUR;
    const latest = { ...north(900), accuracyM: 5 };
    await send(MAX, { type: 'sos.start', sosId: 'sos-again-01', text: 'Hilfe', others: [] }, base);
    await send(MAX, { type: 'sos.update', sosId: 'sos-again-01', point: latest }, base + 3 * MIN);
    await send(
      MAX,
      { type: 'sos.start', sosId: 'sos-again-01', text: 'Bin im Wald', point: { ...north(400), accuracyM: 5 }, others: [{ key: MIA, name: 'Mia' }] },
      base + 2 * MIN,
    );
    const status = max.getStatus(LISA).sos!;
    expect(status.text).toBe('Bin im Wald');
    expect(status.others.map((o) => o.name)).toEqual(['Mia']);
    expect(status.point?.lat).toBeCloseTo(latest.lat, 6);
    // The first press, caught up once more, brings back neither its text nor an older location.
    await send(MAX, { type: 'sos.start', sosId: 'sos-again-01', text: 'Hilfe', point: { ...north(1), accuracyM: 5 }, others: [] }, base);
    expect(max.getStatus(LISA).sos).toMatchObject({ text: 'Bin im Wald', others: [{ name: 'Mia' }] });
    expect(max.getStatus(LISA).sos!.point?.lat).toBeCloseTo(latest.lat, 6);
  });
});

describe('safety: "Pass auf mich auf" that arrives late or out of order', () => {
  it('still raises the alarm for a watch that went overdue while the watcher was offline', async () => {
    const { lisa, max, tick, now } = await pairedPair();
    await max.stop();
    const watchId = await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: now() + 30 * MIN });
    // Lisa never checks in. Max's phone comes back 2.5 hours later.
    tick(150 * MIN);
    const evs = events(max);
    const got = alerts(max);
    await max.start();
    await flush();
    expect(max.getStatus(LISA).watches?.map((w) => w.watchId)).toEqual([watchId]);
    const [alarm] = schedules(evs, `watch:${LISA}:${watchId}`);
    // Scheduled with the OS a moment from now (also for a phone that is asleep again by then).
    expect(alarm!.at).toBeGreaterThan(now());
    expect(alarm!.at).toBeLessThanOrEqual(now() + 5 * MIN);
    expect(alarm!.level).toBe('alarm');
    tick(5 * MIN);
    await max.tick();
    const overdue = got.filter((a) => a.category === 'watch');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ level: 'alarm', title: '⏰ Lisa hat sich nicht gemeldet' });
  });

  it('does not ring for a late watch whose check-in is caught up right after it', async () => {
    const { lisa, max, maxT, tick, now } = await pairedPair();
    await max.stop();
    const watchId = await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: now() + 30 * MIN });
    tick(40 * MIN);
    await lisa.sendCheckin({ to: [MAX], kind: 'home' });
    tick(2 * HOUR);
    // The check-in's watch.end comes a little after the start, with a tick in between.
    const end = maxT.pending.find((p) => typeOf(p) === 'watch.end')!;
    maxT.pending.splice(maxT.pending.indexOf(end), 1);
    const evs = events(max);
    const got = alerts(max);
    await max.start();
    await flush();
    await max.tick();
    maxT.receive(LISA, end.raw);
    await flush();
    tick(10 * MIN);
    await max.tick();
    expect(got.filter((a) => a.category === 'watch')).toEqual([]);
    expect(evs.some((e) => e.type === 'alarm.cancel' && e.id === `watch:${LISA}:${watchId}`)).toBe(true);
    expect(max.getStatus(LISA).watches ?? []).toEqual([]);
  });

  it('an older copy of a watch does not move its deadline back', async () => {
    const { max, now, tick, forge } = await pairedPair();
    const send = forge(LISA);
    const evs = events(max);
    const got = alerts(max);
    const t0 = now();
    // Lisa started a watch until in 2 hours, then shortened it to 30 minutes. Max gets them reversed.
    await send(MAX, { type: 'watch.start', watchId: 'watch-hike-01', label: 'Wanderung', dueAt: t0 + 30 * MIN }, t0 - MIN);
    await send(MAX, { type: 'watch.start', watchId: 'watch-hike-01', label: 'Wanderung', dueAt: t0 + 2 * HOUR }, t0 - 5 * MIN);
    expect(max.getStatus(LISA).watches?.map((w) => w.dueAt)).toEqual([t0 + 30 * MIN]);
    expect(schedules(evs).at(-1)?.at).toBe(t0 + 30 * MIN);
    tick(31 * MIN);
    await max.tick();
    expect(got.filter((a) => a.category === 'watch')).toHaveLength(1);
  });

  it('an older trip does not replace or end the running one', async () => {
    const { max, now, forge } = await pairedPair();
    const send = forge(LISA);
    const base = now() - HOUR;
    await send(MAX, { type: 'session.start', sessionId: 'trip-new-0001', level: 'precise', destinationName: 'Kino', expiresAt: now() + HOUR }, base + 30 * MIN);
    await send(MAX, { type: 'session.start', sessionId: 'trip-old-0001', level: 'eta', destinationName: 'Arbeit', expiresAt: now() + HOUR }, base);
    await send(MAX, { type: 'session.end', sessionId: 'trip-old-0001', reason: 'stopped' }, base + 10 * MIN);
    await send(MAX, { type: 'session.update', sessionId: 'trip-new-0001', etaMinutes: 12, point: { ...north(800), accuracyM: 10 } }, base + 31 * MIN);
    const trip = max.getStatus(LISA).trip!;
    expect(trip).toMatchObject({ sessionId: 'trip-new-0001', destinationName: 'Kino', level: 'precise', etaMinutes: 12 });
    expect(trip.point?.lat).toBeCloseTo(north(800).lat, 6);
  });

  it('an older arrive or leave does not overwrite the newer one', async () => {
    const { max, now, forge } = await pairedPair();
    const send = forge(LISA);
    const got = alerts(max);
    const base = now() - HOUR;
    await send(MAX, { type: 'place.event', kind: 'arrive', placeName: 'Arbeit' }, base + 30 * MIN);
    await send(MAX, { type: 'place.event', kind: 'leave', placeName: 'Zuhause' }, base);
    expect(max.getStatus(LISA).lastPlace).toMatchObject({ kind: 'arrive', placeName: 'Arbeit' });
    expect(got.map((a) => a.body)).toEqual(['📍 Arbeit']);
  });
});

describe('safety: how loud watch and SOS alarms are', () => {
  it('a watch past the hourly budget still notifies, even muted, with "Unterwegs" off and in quiet mode', async () => {
    const { lisa, max, now, tick } = await pairedPair();
    max.updateContact(LISA, { muted: true });
    await max.setPrefs({ ...max.getState().prefs, off: ['status', 'trip'] });
    await max.setDnd(undefined);
    const evs = events(max);
    const got = alerts(max);
    for (let i = 0; i < 5; i++) await lisa.startWatch({ to: [MAX], label: `Punkt ${i + 1}`, dueAt: now() + (30 + i) * MIN });
    await flush();
    expect(schedules(evs).map((a) => a.level)).toEqual(['alarm', 'alarm', 'alarm', 'alarm', 'normal']);
    tick(40 * MIN);
    await max.tick();
    const overdue = got.filter((a) => a.title.includes('hat sich nicht gemeldet'));
    expect(overdue.map((a) => [a.category, a.level])).toEqual([
      ['watch', 'alarm'],
      ['watch', 'alarm'],
      ['watch', 'alarm'],
      ['watch', 'alarm'],
      ['watch', 'normal'],
    ]);
  });

  it('checkpoints of a long hike planned within one hour all ring loudly', async () => {
    const { lisa, max, now, tick } = await pairedPair();
    const evs = events(max);
    for (let i = 1; i <= 5; i++) {
      await lisa.startWatch({ to: [MAX], label: `Etappe ${i}`, dueAt: now() + i * HOUR });
      tick(5 * MIN);
    }
    await flush();
    expect(schedules(evs).map((a) => a.level)).toEqual(['alarm', 'alarm', 'alarm', 'alarm', 'alarm']);
  });

  it('an SOS past the hourly budget still notifies, even muted, with chats off and in quiet mode', async () => {
    const { lisa, max, tick } = await pairedPair();
    lisa.updateContact(MAX, { emergency: true });
    max.updateContact(LISA, { muted: true });
    await max.setPrefs({ ...max.getState().prefs, off: ['status', 'chat'] });
    await max.setDnd(undefined);
    const got = alerts(max);
    for (let i = 0; i < 6; i++) {
      await lisa.startSos({ text: 'Hosentasche' });
      tick(MIN);
      await lisa.endSos('cancelled');
      tick(MIN);
    }
    await lisa.startSos({ text: 'Jetzt wirklich' });
    await flush();
    const last = got.filter((a) => a.title === '🆘 Lisa braucht Hilfe!').at(-1)!;
    expect(last).toMatchObject({ category: 'sos', level: 'normal', body: 'Jetzt wirklich' });
  });

  it('reschedules a watch alarm when quiet mode or its rules change', async () => {
    const { lisa, max, now } = await pairedPair();
    const evs = events(max);
    const watchId = await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: now() + HOUR });
    await flush();
    const id = `watch:${LISA}:${watchId}`;
    expect(schedules(evs, id).map((a) => a.level)).toEqual(['alarm']);

    // "Pass auf mich auf durchlassen" off: nothing changes until quiet mode is on.
    await max.setPrefs({ ...max.getState().prefs, dnd: { ...max.getState().prefs.dnd, allowWatch: false } });
    expect(schedules(evs, id).map((a) => a.level)).toEqual(['alarm']);
    await max.setDnd(undefined);
    expect(schedules(evs, id).map((a) => a.level)).toEqual(['alarm', 'silent']);
    expect(schedules(evs, id).at(-1)?.at).toBe(now() + HOUR);
    await max.setDnd(0);
    expect(schedules(evs, id).map((a) => a.level)).toEqual(['alarm', 'silent', 'alarm']);
  });
});

describe('safety: the outbox after being offline', () => {
  async function lisaWithFriends() {
    const w = world();
    const t = new SelectiveTransport(w.net, LISA, w.now);
    const lisa = w.make(LISA, 'Lisa', { transport: t });
    await lisa.start();
    const friends = new Map<string, SocialNode>();
    for (const [key, name] of [
      [MAX, 'Max'],
      [MIA, 'Mia'],
      [TOM, 'Tom'],
      [BEN, 'Ben'],
    ] as const) {
      const node = w.make(key, name);
      await node.start();
      await w.pair(lisa, node);
      friends.set(key, node);
    }
    lisa.updateContact(MAX, { emergency: true });
    return { ...w, t, lisa, max: friends.get(MAX)! };
  }

  it('sends a queued SOS even when someone else can never be reached', async () => {
    const { t, lisa, max, tick } = await lisaWithFriends();
    t.offline = true;
    for (const k of [MIA, TOM, BEN]) for (let i = 0; i < 5; i++) await lisa.sendChat(k, `Nachricht ${i}`);
    await lisa.startSos({ text: 'Hilfe' });
    expect(lisa.getState().outbox).toHaveLength(16);
    // Back online, but the relay Mia, Tom and Ben use is gone for good.
    t.offline = false;
    for (const k of [MIA, TOM, BEN]) t.dead.add(k);
    tick(20_000);
    await lisa.tick();
    await flush();
    expect(max.getStatus(LISA).sos?.text).toBe('Hilfe');
  });

  it('people who can never be reached do not hold up messages to others', async () => {
    const { t, lisa, max, tick } = await lisaWithFriends();
    const got: string[] = [];
    max.on((e) => e.type === 'chat' && got.push(e.entry.text));
    t.offline = true;
    for (const k of [MIA, TOM, BEN]) for (let i = 0; i < 3; i++) await lisa.sendChat(k, `Nachricht ${i}`);
    await lisa.sendChat(MAX, 'Bin gleich da');
    t.offline = false;
    for (const k of [MIA, TOM, BEN]) t.dead.add(k);
    for (let i = 0; i < 2; i++) {
      tick(20_000);
      await lisa.tick();
      await flush();
    }
    expect(got).toEqual(['Bin gleich da']);
    expect(lisa.getState().outbox.every((e) => e.to !== MAX)).toBe(true);
  });

  it('really offline, it gives up after a few failed tries instead of trying every message', async () => {
    const { t, lisa, tick } = await lisaWithFriends();
    t.offline = true;
    for (const k of [MAX, MIA, TOM, BEN]) for (let i = 0; i < 3; i++) await lisa.sendChat(k, `Nachricht ${i}`);
    t.attempts.length = 0;
    tick(20_000);
    await lisa.tick();
    expect(t.attempts.length).toBeLessThanOrEqual(3);
    expect(lisa.getState().outbox).toHaveLength(12);
  });
});
