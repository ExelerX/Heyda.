import { describe, expect, it } from 'vitest';
import type { Rule } from './automation/schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './automation/templates';
import { SocialNode, TTL, type NodeEvent } from './node';
import { decodeInvite, INVITE_PREFIX } from './pairing/invite';
import { base64urlEncode } from './util/base64url';
import { serializeAppMessage, type AppMessage, type AppMessageBody } from './protocol/messages';
import { createInitialState, type Alert, type NodeState } from './state';
import { MemoryNetwork, MemoryTransport } from './transport/memory';
import type { IncomingMessage, SendOptions, Transport } from './transport/transport';

/**
 * Regression tests for the security review: each one first reproduced a concrete problem
 * (malicious contact, stranger, relay, lost sync, clock skew) before it was fixed.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const MALLORY = '3'.repeat(64);
const MIA = '4'.repeat(64);
const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });
const RELAY = ['wss://relay.example'];
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function state(key: string, name: string, deviceId = `dev-${name}-00`): NodeState {
  return createInitialState({ key, name, relays: RELAY, deviceId, deviceName: `${name}s Handy` });
}

function rule(id: string, values: Record<string, string | number>): Rule {
  const r = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === id)!, values);
  if (!r.ok) throw new Error(r.errors.join(', '));
  return r.value;
}

const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

/** A registered memory transport whose sending can be switched off, like a phone without network. */
class FlakyTransport implements Transport {
  offline = false;
  constructor(private readonly inner: MemoryTransport) {}
  get selfKey(): string {
    return this.inner.selfKey;
  }
  start(): Promise<void> {
    return this.inner.start();
  }
  stop(): Promise<void> {
    return this.inner.stop();
  }
  async send(to: string, message: AppMessage, options?: SendOptions): Promise<void> {
    if (this.offline) throw new Error('offline');
    return this.inner.send(to, message, options);
  }
  onMessage(handler: (m: IncomingMessage) => void): () => void {
    return this.inner.onMessage(handler);
  }
}

function world() {
  let clock = 12 * HOUR;
  const now = () => clock;
  const net = new MemoryNetwork();
  const make = (
    key: string,
    name: string,
    opts: { transport?: Transport; initial?: NodeState; skewMs?: number } = {},
  ) => {
    const nodeNow = () => clock + (opts.skewMs ?? 0);
    return new SocialNode({
      transport: opts.transport ?? net.createTransport(key, now),
      initialState: opts.initial ?? state(key, name),
      now: nodeNow,
      localTime,
      syncDelayMs: 0,
    });
  };
  const pair = async (a: SocialNode, b: SocialNode) => {
    await a.acceptInvite(b.createInvite());
    await flush();
  };
  /** Sends a hand-made message as `from`, like a modified app on that person's phone would. */
  const forge = (from: string) => {
    const t = net.createTransport(from, now);
    let n = 0;
    return (to: string, body: AppMessageBody, sentAt = clock) =>
      t.send(to, { ...body, v: 1, id: `forged-${from.slice(0, 4)}-${String(n++).padStart(6, '0')}`, sentAt } as AppMessage);
  };
  return { net, now, tick: (ms: number) => (clock += ms), make, pair, forge };
}

async function pairedPair() {
  const w = world();
  const flaky = new FlakyTransport(w.net.createTransport(LISA, w.now));
  const lisa = w.make(LISA, 'Lisa', { transport: flaky });
  const max = w.make(MAX, 'Max');
  await lisa.start();
  await max.start();
  await w.pair(lisa, max);
  return { ...w, lisa, max, flaky };
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

/** Lisa's phone and desktop: one account, two devices that know each other. */
async function twoDevices(opts: { deskSkewMs?: number } = {}) {
  const w = world();
  const phone = w.make(LISA, 'Lisa', {
    initial: { ...state(LISA, 'Lisa', 'dev-phone-01'), devices: [{ deviceId: 'dev-desk-001', name: 'PC', linkedAt: 0 }] },
  });
  const desk = w.make(LISA, 'Lisa', {
    initial: { ...state(LISA, 'Lisa', 'dev-desk-001'), devices: [{ deviceId: 'dev-phone-01', name: 'Handy', linkedAt: 0 }] },
    skewMs: opts.deskSkewMs,
  });
  await phone.start();
  await desk.start();
  const sync = async (rounds = 3) => {
    for (let i = 0; i < rounds; i++) {
      await phone.flushSync();
      await flush();
      await desk.flushSync();
      await flush();
    }
  };
  return { ...w, phone, desk, sync };
}

const syncChunks = (net: MemoryNetwork) => net.log.filter((l) => l.from === LISA && l.to === LISA && l.message.type === 'xfer.chunk').length;

describe('security: alarms and quiet mode', () => {
  it('a contact cannot ring watch alarms over and over through quiet mode', async () => {
    const { lisa, now, tick, forge } = await pairedPair();
    await lisa.setDnd(undefined);
    const evs = events(lisa);
    const max = forge(MAX);
    for (let i = 0; i < 20; i++) {
      const watchId = `evil-watch-${String(i).padStart(3, '0')}`;
      // Already overdue on arrival, so it rings right away ...
      await max(LISA, { type: 'watch.start', watchId, label: 'x', dueAt: now() - 30 * 60_000 });
      await flush();
      await lisa.tick();
      // ... and moving the deadline by a minute used to make it ring again.
      await max(LISA, { type: 'watch.start', watchId, label: 'x', dueAt: now() - 29 * 60_000 });
      await flush();
      await lisa.tick();
      await max(LISA, { type: 'watch.end', watchId, reason: 'cancelled' });
      await flush();
      tick(60_000);
    }
    const loud = evs.filter(
      (e) => (e.type === 'alert' && e.alert.level === 'alarm') || (e.type === 'alarm.schedule' && e.alarm.level === 'alarm'),
    );
    // A few loud rings per hour stay possible (a real emergency), the rest is a normal notification.
    expect(loud.length).toBeLessThanOrEqual(8);
  });

  it('still rings loudly for a real watch that was extended several times', async () => {
    const { lisa, max, now, tick } = await pairedPair();
    const evs = events(max);
    const watchId = await lisa.startWatch({ to: [MAX], label: 'Wanderung', dueAt: now() + 30 * 60_000 });
    for (let i = 1; i <= 6; i++) {
      tick(5 * 60_000);
      await lisa.extendWatch(watchId, now() + 30 * 60_000);
    }
    await flush();
    const schedules = evs.filter((e) => e.type === 'alarm.schedule');
    expect(schedules.length).toBe(7);
    expect(schedules.every((e) => e.type === 'alarm.schedule' && e.alarm.level === 'alarm')).toBe(true);
    const got = alerts(max);
    tick(31 * 60_000);
    await max.tick();
    expect(got.filter((a) => a.category === 'watch' && a.level === 'alarm')).toHaveLength(1);
  });
});

describe('security: ghost mode', () => {
  it('ends a running trip, so neither GPS keeps running nor arrival is announced', async () => {
    const { net, lisa, max, now, tick } = await pairedPair();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Zuhause', destination: home, level: 'eta' });
    await flush();
    await lisa.setGhost(true);
    await flush();
    expect(lisa.activeTrip).toBeUndefined();
    expect(lisa.locationNeeds().mode).toBe('off');
    expect(max.getStatus(LISA).trip).toBeUndefined();

    const before = net.log.length;
    tick(60_000);
    await lisa.onLocationFix({ ...north(5), timestamp: now(), accuracyM: 5 });
    await flush();
    expect(net.log.slice(before).filter((l) => l.from === LISA)).toEqual([]);
    await expect(lisa.startTrip({ recipients: [MAX], destinationName: 'Kino' })).rejects.toThrow(/Geistmodus/);
  });

  it('keeps automations that react to my location from telling anyone', async () => {
    const { lisa, max } = await pairedPair();
    lisa.setPlaces([
      { id: 'home', name: 'Zuhause', center: home, radiusM: 100 },
      { id: 'work', name: 'Arbeit', center: north(5000), radiusM: 100 },
    ]);
    lisa.setRules([
      rule('core.home-safe', { myplace: 'home', contact: MAX }),
      rule('core.home-status', { myplace: 'home' }),
      rule('core.share-on-leave', { from: 'work', to: 'home', contact: MAX }),
    ]);
    lisa.syncPlaceState('work', true);
    await lisa.setGhost(true);
    await lisa.onPlaceTransition('work', 'leave');
    await lisa.onPlaceTransition('home', 'arrive');
    await flush();
    expect(max.getStatus(LISA).lastCheckin).toBeUndefined();
    expect(max.getStatus(LISA).presence?.status).toBeUndefined();
    expect(max.getStatus(LISA).trip).toBeUndefined();
    expect(lisa.activeTrip).toBeUndefined();
  });

  it('drops queued location updates instead of sending them once back online', async () => {
    const { net, lisa, max, now, tick, flaky } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await flush();
    flaky.offline = true;
    await lisa.onLocationFix({ ...north(700), timestamp: now(), accuracyM: 5 });
    expect(lisa.getState().outbox.some((e) => e.message.type === 'live.update')).toBe(true);
    await lisa.setGhost(true);
    flaky.offline = false;
    tick(20_000);
    await lisa.tick();
    await flush();
    expect(net.log.filter((l) => l.from === LISA && l.message.type === 'live.update')).toEqual([]);
    expect(max.getStatus(LISA).live).toBeUndefined();
  });

  it('does not attach the place I am at to an automatic or a ghost-mode check-in', async () => {
    const { lisa, max } = await pairedPair();
    lisa.setPlaces([{ id: 'home', name: 'Zuhause', center: home, radiusM: 100 }]);
    lisa.syncPlaceState('home', true);
    // Max has no grant for "Zuhause". A rule answers his pings with "Alles okay".
    lisa.setRules([
      {
        id: 'reply-ok-rule',
        name: 'Antwort',
        enabled: true,
        trigger: { on: 'contact.ping', contact: MAX },
        conditions: [],
        actions: [{ do: 'send_checkin', to: [MAX], kind: 'ok' }],
        source: 'manual',
      },
    ]);
    await max.sendPing(LISA, 'call-me');
    await flush();
    expect(max.getStatus(LISA).lastCheckin?.kind).toBe('ok');
    expect(max.getStatus(LISA).lastCheckin?.placeName).toBeUndefined();

    lisa.setRules([]);
    await lisa.setGhost(true);
    await lisa.sendCheckin({ to: [MAX], kind: 'home' });
    await flush();
    expect(max.getStatus(LISA).lastCheckin?.kind).toBe('home');
    expect(max.getStatus(LISA).lastCheckin?.placeName).toBeUndefined();
  });
});

describe('security: outbox', () => {
  it('removing a contact drops location updates still queued for them', async () => {
    const { net, lisa, now, tick, flaky } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    flaky.offline = true;
    await lisa.onLocationFix({ ...north(700), timestamp: now(), accuracyM: 5 });
    await lisa.removeContact(MAX);
    flaky.offline = false;
    tick(20_000);
    await lisa.tick();
    await flush();
    expect(net.log.filter((l) => l.from === LISA && l.message.type === 'live.update')).toEqual([]);
  });

  it('one message that can never be sent does not block the group or the outbox', async () => {
    const w = world();
    const flaky = new FlakyTransport(w.net.createTransport(LISA, w.now));
    // Mallory's relay came from a QR code (or older data) and is not a valid wire relay.
    const initial: NodeState = {
      ...state(LISA, 'Lisa'),
      contacts: [{ key: MALLORY, name: 'Mallory', relays: ['wss://relay.example/?x=1'], addedAt: 0, verified: false }],
    };
    const lisa = w.make(LISA, 'Lisa', { transport: flaky, initial });
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);

    await lisa.createGroup('Familie', [MAX, MALLORY]);
    await flush();
    expect(max.getState().groups.map((g) => g.name)).toEqual(['Familie']);

    const got: string[] = [];
    max.on((e) => e.type === 'chat' && got.push(e.entry.text));
    flaky.offline = true;
    await lisa.sendChat(MAX, 'kommt später an');
    flaky.offline = false;
    w.tick(20_000);
    await lisa.tick();
    await flush();
    expect(got).toEqual(['kommt später an']);
  });

  it('QR codes with relay addresses the wire format rejects are refused', () => {
    // Hand-made, as encodeInvite itself refuses such relays.
    const qr = (relays: string[]) =>
      INVITE_PREFIX + base64urlEncode(new TextEncoder().encode(JSON.stringify({ k: MALLORY, n: 'Mallory', r: relays, c: 'abcdefghijkl', e: 10_000 })));
    expect(decodeInvite(qr(['wss://relay.example/?x=1']), 0).ok).toBe(false);
    expect(decodeInvite(qr(RELAY), 0).ok).toBe(true);
  });

  it('a retried message keeps its original expiry on the relays', async () => {
    const { net, lisa, tick, flaky } = await pairedPair();
    flaky.offline = true;
    await lisa.sendChat(MAX, 'alt');
    tick(3 * DAY);
    flaky.offline = false;
    await lisa.tick();
    const sent = net.log.find((l) => l.from === LISA && l.message.type === 'chat.text');
    expect(sent?.options?.ttlSeconds).toBeLessThanOrEqual(TTL.chat - 3 * 24 * 3600 + 1);
  });
});

describe('security: replays, late messages and clocks', () => {
  it('a late SOS start does not revive an SOS that already ended, even after a restart', async () => {
    const { net, lisa, max, now, forge } = await pairedPair();
    lisa.updateContact(MAX, { emergency: true });
    await lisa.startSos({ text: 'Hilfe' });
    await flush();
    const sosId = max.getStatus(LISA).sos!.sosId;
    await lisa.endSos('safe');
    await flush();

    await max.stop();
    const again = new SocialNode({
      transport: net.createTransport(MAX, now),
      initialState: max.getState(),
      initialStatuses: max.exportStatuses(),
      now,
      localTime,
    });
    await again.start();
    const got = alerts(again);
    // A copy of Lisa's second press, held back by a relay, arrives after the restart.
    await forge(LISA)(MAX, { type: 'sos.start', sosId, text: 'Hilfe', others: [] });
    await flush();
    expect(again.getStatus(LISA).sos?.endedAt).toBeDefined();
    expect(got).toEqual([]);
  });

  it("strangers cannot flush the duplicate filter to get a contact's message handled twice", async () => {
    const { net, lisa, max, forge } = await pairedPair();
    const got = alerts(max);
    await lisa.sendChat(MAX, 'einmal');
    await flush();
    const original = net.log.find((l) => l.from === LISA && l.message.type === 'chat.text')!;
    const stranger = forge(MALLORY);
    for (let i = 0; i < 5001; i++) await stranger(MAX, { type: 'ping', kind: 'custom' });
    await flush();
    // A relay hands Lisa's message over once more.
    net.deliver(LISA, MAX, serializeAppMessage(original.message));
    await flush();
    expect(got.filter((a) => a.body === 'einmal')).toHaveLength(1);
  });

  it('a contact whose clock ran ahead does not freeze their status updates', async () => {
    const { lisa, max, now, tick, forge } = await pairedPair();
    await forge(MAX)(LISA, { type: 'presence', status: { text: 'Alt', expiresAt: now() + 2 * DAY }, dnd: null }, now() + DAY);
    await flush();
    expect(lisa.getStatus(MAX).presence?.status?.text).toBe('Alt');
    tick(15 * 60_000);
    await max.setMyStatus({ text: 'Neu', hours: 1 });
    await flush();
    expect(lisa.getStatus(MAX).presence?.status?.text).toBe('Neu');
  });

  it('a contact cannot grow my copy of their SOS without bound', async () => {
    const { lisa, max, forge } = await pairedPair();
    max.updateContact(LISA, { emergency: true });
    await max.startSos();
    await flush();
    const sosId = lisa.getStatus(MAX).sos!.sosId;
    const send = forge(MAX);
    for (let i = 0; i < 20; i++) {
      const acks = Array.from({ length: 20 }, (_, j) => ({ key: (0x1000 + i * 20 + j).toString(16).padStart(64, '0'), name: 'Helfer' }));
      await send(LISA, { type: 'sos.update', sosId, acks });
    }
    await flush();
    expect(lisa.getStatus(MAX).sos!.acks.length).toBeLessThanOrEqual(50);
  });

  it('a contact cannot rewrite my contact list by flooding name changes', async () => {
    const { lisa, forge } = await pairedPair();
    const names = new Set<string>();
    lisa.on((e) => e.type === 'state' && names.add(e.state.contacts[0]!.name));
    const send = forge(MAX);
    for (let i = 0; i < 30; i++) await send(LISA, { type: 'hello', name: `Name ${i}`, relays: RELAY });
    await flush();
    expect(names.size).toBeLessThanOrEqual(10);
  });
});

describe('security: my own watches', () => {
  it('refuses a watch the recipient would silently ignore', async () => {
    const { lisa, now } = await pairedPair();
    for (let i = 0; i < 10; i++) await lisa.startWatch({ to: [MAX], label: `W${i}`, dueAt: now() + HOUR });
    await expect(lisa.startWatch({ to: [MAX], label: 'zu viel', dueAt: now() + HOUR })).rejects.toThrow();
    expect(lisa.getState().watches).toHaveLength(10);
  });

  it('never drops a running watch that others still wait on', async () => {
    const { lisa, max, make, pair, now } = await pairedPair();
    const mia = make(MIA, 'Mia');
    await mia.start();
    await pair(lisa, mia);
    const first = await lisa.startWatch({ to: [MAX], label: 'Erste', dueAt: now() + HOUR });
    for (let i = 0; i < 9; i++) await lisa.startWatch({ to: [MAX], label: `M${i}`, dueAt: now() + HOUR });
    for (let i = 0; i < 10; i++) await lisa.startWatch({ to: [MIA], label: `I${i}`, dueAt: now() + HOUR });
    await expect(lisa.startWatch({ to: [MIA, MAX], label: 'zu viel', dueAt: now() + HOUR })).rejects.toThrow();
    await flush();
    expect(lisa.getState().watches.some((w) => w.watchId === first)).toBe(true);
    expect(max.getStatus(LISA).watches?.some((w) => w.watchId === first)).toBe(true);
  });
});

describe('security: syncing my own devices', () => {
  it('two devices whose lists are in a different order stop syncing once they agree', async () => {
    const { net, phone, desk, make, pair, sync } = await twoDevices();
    const max = make(MAX, 'Max');
    const mia = make(MIA, 'Mia');
    await max.start();
    await mia.start();
    await pair(phone, max);
    await pair(desk, mia);
    await sync(3);
    expect(phone.getState().contacts.map((c) => c.key).sort()).toEqual([MAX, MIA]);
    expect(desk.getState().contacts.map((c) => c.key).sort()).toEqual([MAX, MIA]);
    const settled = syncChunks(net);
    await sync(5);
    expect(syncChunks(net)).toBe(settled);
  });

  it('removing a contact on one device also removes its place grants on the others', async () => {
    const { phone, desk, make, pair, sync } = await twoDevices();
    const max = make(MAX, 'Max');
    await max.start();
    await pair(phone, max);
    phone.setGrants([{ contactKey: MAX, placeIds: ['home'] }]);
    await sync(2);
    expect(desk.getState().grants).toHaveLength(1);
    await phone.removeContact(MAX);
    await sync(2);
    expect(desk.getState().contacts).toEqual([]);
    expect(desk.getState().grants).toEqual([]);
  });

  it('a group I left on one device does not come back from another device', async () => {
    const { phone, desk, make, pair, sync } = await twoDevices();
    const max = make(MAX, 'Max');
    await max.start();
    await pair(phone, max);
    await sync(2);
    const group = await max.createGroup('Familie', [LISA]);
    await flush();
    expect(phone.getState().groups.map((g) => g.id)).toEqual([group.id]);
    expect(desk.getState().groups.map((g) => g.id)).toEqual([group.id]);
    await phone.leaveGroup(group.id);
    await sync(3);
    expect(phone.getState().groups).toEqual([]);
    expect(desk.getState().groups).toEqual([]);
  });

  it('a later edit wins even if another device has a clock that runs ahead', async () => {
    const { phone, desk, make, pair, sync, tick } = await twoDevices({ deskSkewMs: HOUR });
    const max = make(MAX, 'Max');
    await max.start();
    await pair(phone, max);
    await sync(2);
    desk.updateContact(MAX, { nickname: 'Alt' });
    await sync(2);
    tick(60_000);
    phone.updateContact(MAX, { nickname: 'Neu' });
    await sync(3);
    expect(phone.getState().contacts[0]?.nickname).toBe('Neu');
    expect(desk.getState().contacts[0]?.nickname).toBe('Neu');

    // A removal after an edit from the fast device sticks as well.
    tick(60_000);
    await phone.removeContact(MAX);
    await sync(3);
    expect(desk.getState().contacts).toEqual([]);
    expect(phone.getState().contacts).toEqual([]);
  });
});
