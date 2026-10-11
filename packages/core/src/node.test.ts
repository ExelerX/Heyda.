import { describe, expect, it } from 'vitest';
import type { Rule } from './automation/schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './automation/templates';
import { SocialNode, type NodeEvent } from './node';
import { createInitialState, type Alert, type NodeState } from './state';
import { encodeLinkInvite } from './sync/link';
import { createLinkedState, LinkReceiver } from './sync/receiver';
import { MemoryNetwork, MemoryTransport } from './transport/memory';
import type { AppMessage } from './protocol/messages';
import type { SendOptions } from './transport/transport';

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const MALLORY = '3'.repeat(64);
const MIA = '4'.repeat(64);
const TEMP = '5'.repeat(64);
const LISA_SECRET = 'a'.repeat(64);
const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });
const RELAY = ['wss://relay.example'];

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

/** Noon on a Wednesday, so scheduled quiet hours are predictable. */
const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

function world() {
  let clock = 12 * 3600_000;
  const now = () => clock;
  const net = new MemoryNetwork();
  const nodes: SocialNode[] = [];
  const make = (key: string, name: string, opts: { transport?: MemoryTransport | FlakyTransport; initial?: NodeState } = {}) => {
    const node = new SocialNode({
      transport: opts.transport ?? net.createTransport(key, now),
      initialState: opts.initial ?? state(key, name),
      now,
      localTime,
      syncDelayMs: 0,
    });
    nodes.push(node);
    return node;
  };
  const pair = async (a: SocialNode, b: SocialNode) => {
    await a.acceptInvite(b.createInvite());
    await flush();
  };
  return { net, now, tick: (ms: number) => (clock += ms), make, pair };
}

async function pairedPair() {
  const w = world();
  const lisa = w.make(LISA, 'Lisa');
  const max = w.make(MAX, 'Max');
  await lisa.start();
  await max.start();
  // Max shows a QR code, Lisa scans it.
  await w.pair(lisa, max);
  return { ...w, lisa, max };
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

class FlakyTransport extends MemoryTransport {
  offline = false;
  override async send(to: string, message: AppMessage, options?: SendOptions): Promise<void> {
    if (this.offline) throw new Error('offline');
    return super.send(to, message, options);
  }
}

describe('SocialNode: contacts and trips', () => {
  it('pairs two phones through a scanned QR code', async () => {
    const { lisa, max } = await pairedPair();
    expect(lisa.getState().contacts.map((c) => c.name)).toEqual(['Max']);
    expect(max.getState().contacts.map((c) => c.name)).toEqual(['Lisa']);
    expect(max.getState().openInvites).toEqual([]);
  });

  it('drops messages from strangers and replayed invites', async () => {
    const { net, max, make } = await pairedPair();
    const evs = events(max);
    const mallory = make(MALLORY, 'Mallory');
    await mallory.start();
    // Mallory is not a contact of Max, so sending just does nothing on Mallory's side ...
    await mallory.sendChat(MAX, 'hi').catch(() => undefined);
    // ... and forged messages are ignored by Max.
    const t = net.createTransport(MALLORY);
    await t.send(MAX, { v: 1, id: 'forged-hello-1', sentAt: 0, type: 'hello', name: 'Mallory', relays: [] });
    await t.send(MAX, { v: 1, id: 'forged-sos-01', sentAt: 0, type: 'sos.start', sosId: 'abcdefgh', others: [] });
    await flush();
    expect(max.getState().contacts.map((c) => c.name)).toEqual(['Lisa']);
    expect(evs.filter((e) => e.type === 'contact.added' || e.type === 'alert')).toEqual([]);
  });

  it('shares a trip as rounded ETAs and fires "almost there" on the other phone', async () => {
    const { lisa, max, tick, now } = await pairedPair();
    max.setRules([rule('core.almost-there', { contact: LISA, minutes: 5 })]);
    const got = alerts(max);

    await lisa.startTrip({ recipients: [MAX], destinationName: 'Bei Max', destination: home, level: 'eta' });
    await flush();
    expect(max.getStatus(LISA).trip?.destinationName).toBe('Bei Max');
    expect(got.map((a) => a.title)).toContain('Lisa ist unterwegs');

    for (const meters of [3000, 2500, 2000, 1500, 1000, 500, 300]) {
      tick(60_000);
      await lisa.onLocationFix({ ...north(meters), timestamp: now(), accuracyM: 10, speedMps: 8 });
      await flush();
    }
    const eta = max.getStatus(LISA).trip?.etaMinutes;
    expect(eta).toBeDefined();
    expect(eta!).toBeLessThanOrEqual(5);
    expect(got.filter((a) => a.category === 'automation').map((a) => a.body)).toEqual([
      expect.stringMatching(/^Lisa kommt (gleich|in ca\. \d+ min) an\.$/),
    ]);
    // No coordinates ever reached Max at the "eta" level.
    expect(max.getStatus(LISA).trip?.cell).toBeUndefined();
    expect(max.getStatus(LISA).trip?.point).toBeUndefined();

    tick(60_000);
    await lisa.onLocationFix({ ...north(10), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).trip).toBeUndefined();
    expect(lisa.activeTrip).toBeUndefined();
    expect(got.map((a) => a.title)).toContain('Lisa ist angekommen');
  });

  it('ends a trip on time even without new location fixes', async () => {
    const { lisa, max, tick } = await pairedPair();
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Kino', durationMs: 30 * 60_000 });
    await flush();
    tick(31 * 60_000);
    await lisa.tick();
    await flush();
    expect(lisa.activeTrip).toBeUndefined();
    expect(max.getStatus(LISA).trip).toBeUndefined();
  });

  it('sends place events only for granted places and nothing in ghost mode', async () => {
    const { lisa, max, tick, now } = await pairedPair();
    lisa.setPlaces([{ id: 'store', name: 'Supermarkt', center: home, radiusM: 100 }]);
    lisa.setGrants([{ contactKey: MAX, placeIds: ['store'] }]);
    max.setRules([rule('core.shopping-help', { contact: LISA, place: 'Supermarkt' })]);
    const got = alerts(max);

    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 }); // starts inside, silent
    tick(60_000);
    await lisa.onLocationFix({ ...north(400), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).lastPlace).toMatchObject({ kind: 'leave', placeName: 'Supermarkt' });
    expect(got.filter((a) => a.category === 'automation').map((a) => a.title)).toEqual(['Einkauf ist unterwegs 🛍️']);

    await lisa.setGhost(true);
    tick(60_000);
    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 });
    tick(120_000);
    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).lastPlace?.kind).toBe('leave');
  });

  it('lets an automation start a trip, but only at the ETA level', async () => {
    const { lisa, max, tick, now } = await pairedPair();
    lisa.setPlaces([
      { id: 'work', name: 'Arbeit', center: north(5000), radiusM: 150 },
      { id: 'home', name: 'Zuhause', center: home, radiusM: 100 },
    ]);
    lisa.setRules([rule('core.share-on-leave', { from: 'work', to: 'home', contact: MAX })]);
    await lisa.onLocationFix({ ...north(5000), timestamp: now(), accuracyM: 10 });
    tick(60_000);
    await lisa.onLocationFix({ ...north(4500), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(lisa.activeTrip?.level).toBe('eta');
    expect(max.getStatus(LISA).trip?.destinationName).toBe('Zuhause');
  });

  it('handles arrive/leave reported natively by the OS', async () => {
    const { lisa, max } = await pairedPair();
    lisa.setPlaces([{ id: 'home', name: 'Zuhause', center: home, radiusM: 100 }]);
    lisa.setGrants([{ contactKey: MAX, placeIds: ['home'] }]);
    await lisa.onPlaceTransition('home', 'arrive');
    await lisa.onPlaceTransition('home', 'arrive'); // duplicate from the OS is ignored
    await flush();
    expect(max.getStatus(LISA).lastPlace).toMatchObject({ kind: 'arrive', placeName: 'Zuhause' });
  });

  it('resumes a trip after a restart without announcing it again', async () => {
    const { net, lisa, max, now, tick } = await pairedPair();
    const session = await lisa.startTrip({ recipients: [MAX], destinationName: 'Bei Max', destination: home, level: 'eta' });
    await flush();
    const before = net.log.filter((l) => l.message.type === 'session.start').length;

    await lisa.stop();
    const relaunched = new SocialNode({ transport: net.createTransport(LISA, now), initialState: lisa.getState(), now });
    await relaunched.start();
    expect(relaunched.resumeTrip(session)).toBe(true);
    expect(relaunched.resumeTrip(session)).toBe(false); // already running
    tick(60_000);
    await relaunched.onLocationFix({ ...north(2000), timestamp: now(), accuracyM: 10, speedMps: 8 });
    await flush();
    expect(net.log.filter((l) => l.message.type === 'session.start').length).toBe(before);
    expect(max.getStatus(LISA).trip?.etaMinutes).toBeDefined();

    tick(25 * 3600_000);
    const later = new SocialNode({ transport: net.createTransport(LISA, now), initialState: lisa.getState(), now });
    expect(later.resumeTrip(session)).toBe(false);
  });

  it('syncs the OS-reported place state silently', async () => {
    const { lisa, max } = await pairedPair();
    lisa.setPlaces([{ id: 'home', name: 'Zuhause', center: home, radiusM: 100 }]);
    lisa.setGrants([{ contactKey: MAX, placeIds: ['home'] }]);
    lisa.syncPlaceState('home', true);
    await lisa.onPlaceTransition('home', 'arrive');
    await flush();
    expect(max.getStatus(LISA).lastPlace).toBeUndefined();
    await lisa.onPlaceTransition('home', 'leave');
    await flush();
    expect(max.getStatus(LISA).lastPlace).toMatchObject({ kind: 'leave' });
  });

  it('keeps local contact settings to itself and restores statuses after a restart', async () => {
    const { net, lisa, max, now } = await pairedPair();
    lisa.updateContact(MAX, { nickname: 'Maxi', favorite: true, phone: '+49 170 1234567', emergency: true });
    expect(lisa.getState().contacts[0]).toMatchObject({ nickname: 'Maxi', favorite: true, phone: '+491701234567', emergency: true });
    expect(lisa.name(MAX)).toBe('Maxi');
    expect(net.log.some((l) => JSON.stringify(l.message).includes('Maxi'))).toBe(false);

    await max.setMyStatus({ text: 'Im Kino', emoji: '🎬', hours: 2 });
    await flush();
    const saved = lisa.exportStatuses();
    const again = new SocialNode({ transport: net.createTransport(LISA, now), initialState: lisa.getState(), initialStatuses: saved, now });
    expect(again.getStatus(MAX).presence?.status?.text).toBe('Im Kino');
  });
});

describe('SocialNode: quiet mode and notifications', () => {
  it('turns notifications silent in quiet mode, lets favourites and urgent ones through', async () => {
    const { lisa, max, make, pair } = await pairedPair();
    const mia = make(MIA, 'Mia');
    await mia.start();
    await pair(mia, lisa);
    const got = alerts(lisa);
    await lisa.setDnd(60);
    await max.sendChat(LISA, 'normal');
    await flush();
    expect(got.at(-1)).toMatchObject({ category: 'chat', level: 'silent' });

    // Urgent from a non-favourite: default only favourites may break through.
    await max.sendChat(LISA, 'dringend', { urgent: true });
    await flush();
    expect(got.at(-1)?.level).toBe('silent');

    lisa.updateContact(MIA, { favorite: true });
    await mia.sendChat(LISA, 'von Mia');
    await flush();
    expect(got.at(-1)).toMatchObject({ body: 'von Mia', level: 'normal' });

    await lisa.setPrefs({ ...lisa.getState().prefs, dnd: { ...lisa.getState().prefs.dnd, urgentFrom: 'all' } });
    await max.sendChat(LISA, 'wirklich dringend', { urgent: true });
    await flush();
    expect(got.at(-1)).toMatchObject({ body: 'wirklich dringend', level: 'normal' });
  });

  it('tells contacts about quiet mode and status, and clears it when it ends', async () => {
    const { lisa, max, tick } = await pairedPair();
    await lisa.setDnd(30);
    await flush();
    expect(max.getStatus(LISA).presence?.dnd?.until).toBeDefined();
    tick(31 * 60_000);
    await lisa.tick();
    await flush();
    expect(lisa.isDndActive()).toBe(false);
    expect(max.getStatus(LISA).presence?.dnd).toBeUndefined();
  });

  it('follows the quiet-hours schedule', async () => {
    const { lisa, max, tick } = await pairedPair();
    await lisa.setPrefs({
      ...lisa.getState().prefs,
      dnd: { ...lisa.getState().prefs.dnd, schedule: { enabled: true, from: '13:00', to: '14:00', days: [1, 2, 3, 4, 5, 6, 7] } },
    });
    expect(lisa.isDndActive()).toBe(false);
    tick(65 * 60_000);
    await lisa.tick();
    await flush();
    expect(lisa.isDndActive()).toBe(true);
    expect(max.getStatus(LISA).presence?.dnd).toBeDefined();
  });

  it('puts a flood of messages into the activity list instead of ringing', async () => {
    const { lisa, max } = await pairedPair();
    const got = alerts(lisa);
    for (let i = 0; i < 25; i++) await max.sendChat(LISA, `spam ${i}`);
    await flush();
    expect(got.filter((a) => a.level === 'normal').length).toBe(20);
    expect(got.filter((a) => a.level === 'feed').length).toBe(5);
  });
});

describe('SocialNode: safety', () => {
  it('sends an SOS with location even in ghost mode, and it always rings', async () => {
    const { lisa, max, make, pair, now } = await pairedPair();
    const mia = make(MIA, 'Mia');
    await mia.start();
    await pair(lisa, mia);
    lisa.updateContact(MAX, { emergency: true });
    lisa.updateContact(MIA, { emergency: true });
    await lisa.setGhost(true);
    await lisa.onLocationFix({ ...north(100), timestamp: now(), accuracyM: 8 });

    max.updateContact(LISA, { muted: true });
    await max.setDnd(undefined);
    const got = alerts(max);
    await lisa.startSos({ text: 'Bin gestürzt' });
    await flush();
    const sos = max.getStatus(LISA).sos!;
    expect(sos.text).toBe('Bin gestürzt');
    expect(sos.point?.lat).toBeCloseTo(north(100).lat, 6);
    expect(sos.others.map((o) => o.name)).toEqual(['Mia']);
    expect(got.at(-1)).toMatchObject({ category: 'sos', level: 'alarm' });
    expect(lisa.locationNeeds().mode).toBe('high');

    // Max takes care; Lisa and Mia (another helper) both learn it.
    await max.ackSos(LISA, 'Bin in 5 min da');
    await flush();
    expect(lisa.getState().sos?.acks.map((a) => a.key)).toEqual([MAX]);
    expect(mia.getStatus(LISA).sos?.acks.map((a) => a.name)).toEqual(['Max']);

    await lisa.endSos('safe');
    await flush();
    expect(max.getStatus(LISA).sos?.endReason).toBe('safe');
    expect(lisa.locationNeeds().mode).toBe('off');
    expect(lisa.sosFallback()).toBeUndefined();
  });

  it('builds an SMS fallback with the emergency contacts\' numbers', async () => {
    const { lisa, now } = await pairedPair();
    lisa.updateContact(MAX, { emergency: true, phone: '0170 555' });
    await lisa.onLocationFix({ ...home, timestamp: now(), accuracyM: 5 });
    await lisa.startSos();
    const fb = lisa.sosFallback()!;
    expect(fb.phones).toEqual(['0170555']);
    expect(fb.text).toContain('Lisa braucht Hilfe');
    expect(fb.text).toContain('openstreetmap.org/?mlat=52.52000&mlon=13.40500');
  });

  it('refuses an SOS without emergency contacts', async () => {
    const { lisa } = await pairedPair();
    await expect(lisa.startSos()).rejects.toThrow(/Notfallkontakte/);
  });

  it('schedules a watch alarm on the recipient and cancels it on check-in', async () => {
    const { lisa, max, now } = await pairedPair();
    const evs = events(max);
    const mine = events(lisa);
    const dueAt = now() + 60 * 60_000;
    await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt });
    await flush();
    const scheduled = evs.find((e) => e.type === 'alarm.schedule');
    expect(scheduled).toMatchObject({ alarm: { at: dueAt, level: 'alarm' } });
    expect(mine.filter((e) => e.type === 'alarm.schedule').length).toBe(2); // reminder + due

    await lisa.sendCheckin({ to: [MAX], kind: 'home' });
    await flush();
    expect(evs.some((e) => e.type === 'alarm.cancel' && scheduled?.type === 'alarm.schedule' && e.id === scheduled.alarm.id)).toBe(true);
    expect(max.getStatus(LISA).watches).toEqual([]);
    expect(max.getStatus(LISA).lastCheckin?.kind).toBe('home');
    expect(lisa.getState().watches).toEqual([]);
  });

  it('raises the overdue alarm once if nobody checked in', async () => {
    const { lisa, max, now, tick } = await pairedPair();
    await lisa.startWatch({ to: [MAX], label: 'Wanderung', dueAt: now() + 30 * 60_000 });
    await flush();
    const got = alerts(max);
    tick(31 * 60_000);
    await max.tick();
    await max.tick();
    const overdue = got.filter((a) => a.category === 'watch');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ level: 'alarm', title: '⏰ Lisa hat sich nicht gemeldet' });
  });

  it('rejects watch times that are too short or too far away', async () => {
    const { lisa, now } = await pairedPair();
    await expect(lisa.startWatch({ to: [MAX], label: 'x', dueAt: now() + 60_000 })).rejects.toThrow();
    await expect(lisa.startWatch({ to: [MAX], label: 'x', dueAt: now() + 72 * 3600_000 })).rejects.toThrow();
  });

  it('ends a trip-linked watch automatically on arrival', async () => {
    const { lisa, max, now, tick } = await pairedPair();
    const trip = await lisa.startTrip({ recipients: [MAX], destinationName: 'Hotel', destination: home });
    await lisa.startWatch({ to: [MAX], label: 'Anreise', dueAt: now() + 3 * 3600_000, tripId: trip.id });
    await flush();
    tick(60_000);
    await lisa.onLocationFix({ ...north(5), timestamp: now(), accuracyM: 5 });
    await flush();
    expect(lisa.getState().watches).toEqual([]);
    expect(max.getStatus(LISA).watches).toEqual([]);
  });
});

describe('SocialNode: live location and where', () => {
  it('shares a precise live location and stops it', async () => {
    const { lisa, max, now, tick } = await pairedPair();
    await lisa.onLocationFix({ ...north(200), timestamp: now(), accuracyM: 10 });
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await flush();
    expect(max.getStatus(LISA).live?.point?.lat).toBeCloseTo(north(200).lat, 6);
    expect(lisa.locationNeeds().mode).toBe('high');

    tick(30_000);
    await lisa.onLocationFix({ ...north(400), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).live?.point?.lat).toBeCloseTo(north(400).lat, 6);

    await lisa.stopLive(MAX);
    await flush();
    expect(max.getStatus(LISA).live).toBeUndefined();
    expect(lisa.locationNeeds().mode).toBe('off');
  });

  it('sends only a grid cell for a coarse share', async () => {
    const { lisa, max, now } = await pairedPair();
    await lisa.onLocationFix({ ...north(200), timestamp: now(), accuracyM: 10 });
    await lisa.startLive({ contacts: [MAX], level: 'coarse', durationMs: 3600_000 });
    await flush();
    const live = max.getStatus(LISA).live!;
    expect(live.point).toBeUndefined();
    expect(live.cell?.cellM).toBe(2000);
    expect(lisa.locationNeeds().mode).toBe('low');
  });

  it('ghost mode blocks and ends live sharing, and shares expire', async () => {
    const { lisa, max, tick } = await pairedPair();
    await lisa.startLive({ contacts: [MAX], level: 'coarse', durationMs: 10 * 60_000 });
    await flush();
    tick(11 * 60_000);
    await lisa.tick();
    await flush();
    expect(lisa.getState().liveShares).toEqual([]);
    expect(max.getStatus(LISA).live).toBeUndefined();

    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await lisa.setGhost(true);
    await flush();
    expect(lisa.getState().liveShares).toEqual([]);
    expect(max.getStatus(LISA).live).toBeUndefined();
    await expect(lisa.startLive({ contacts: [MAX], level: 'coarse' })).rejects.toThrow(/Geistmodus/);
  });

  it('answers "where are you?" only with what was chosen', async () => {
    const { lisa, max, now } = await pairedPair();
    await lisa.onLocationFix({ ...north(300), timestamp: now(), accuracyM: 10 });
    await max.askWhere(LISA);
    await flush();
    const req = lisa.getState().whereInbox[0]!;
    expect(req.from).toBe(MAX);

    await lisa.answerWhere(MAX, req.requestId, { kind: 'coarse' });
    await flush();
    const answer = max.getStatus(LISA).lastWhere!;
    expect(answer.answer).toBe('coarse');
    expect(answer.point).toBeUndefined();
    expect(answer.cell).toBeDefined();
    expect(lisa.getState().whereInbox).toEqual([]);
  });

  it('ignores where-answers nobody asked for', async () => {
    const { net, lisa, max } = await pairedPair();
    const t = net.createTransport(LISA);
    await t.send(MAX, {
      v: 1,
      id: 'unasked-reply-1',
      sentAt: 0,
      type: 'where.reply',
      requestId: 'not-asked-123',
      answer: 'text',
      text: 'hi',
    });
    await flush();
    expect(max.getStatus(LISA).lastWhere).toBeUndefined();
    expect(lisa.getState().whereInbox).toEqual([]);
  });
});

describe('SocialNode: groups', () => {
  async function trio() {
    const w = await pairedPair();
    const mia = w.make(MIA, 'Mia');
    await mia.start();
    await w.pair(w.lisa, mia); // Lisa knows Max and Mia; Max and Mia don't know each other.
    return { ...w, mia };
  }

  it('lets members who are not each other\'s contacts talk in a group', async () => {
    const { lisa, max, mia } = await trio();
    const group = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    expect(max.getState().groups.map((g) => g.name)).toEqual(['Familie']);
    const chats: string[] = [];
    max.on((e) => e.type === 'chat' && e.thread === `g:${group.id}` && chats.push(e.entry.text));
    await mia.sendGroupText(group.id, 'Essen um 7?');
    await flush();
    expect(chats).toEqual(['Essen um 7?']);
    expect(max.name(MIA)).toBe('Mia');
  });

  it('ignores group messages from outsiders and roster changes by non-owners', async () => {
    const { net, lisa, max } = await trio();
    const group = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    const chats: string[] = [];
    max.on((e) => e.type === 'chat' && chats.push(e.entry.text));
    const mallory = net.createTransport(MALLORY);
    await mallory.send(MAX, { v: 1, id: 'outsider-msg-1', sentAt: 0, type: 'group.text', groupId: group.id, text: 'hi' });
    // Mia (a member, not the owner) tries to take over the roster.
    const miaT = net.createTransport(MIA);
    await miaT.send(MAX, {
      v: 1,
      id: 'takeover-msg-1',
      sentAt: 0,
      type: 'group.update',
      groupId: group.id,
      name: 'Meins',
      owner: MIA,
      members: [{ key: MAX, name: 'Max' }],
      version: 99,
    });
    await flush();
    expect(chats).toEqual([]);
    expect(max.getState().groups[0]?.name).toBe('Familie');
  });

  it('removes a member, and a member can leave', async () => {
    const { lisa, max, mia } = await trio();
    const group = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    await lisa.editGroup(group.id, { members: [MAX] });
    await flush();
    expect(mia.getState().groups).toEqual([]);
    expect(max.getState().groups[0]?.members.map((m) => m.name)).toEqual(['Lisa', 'Max']);

    await max.leaveGroup(group.id);
    await flush();
    expect(lisa.getState().groups[0]?.members.map((m) => m.name)).toEqual(['Lisa']);
    // A late update must not add Max back.
    await lisa.editGroup(group.id, { name: 'Neu' }).catch(() => undefined);
    await flush();
    expect(max.getState().groups).toEqual([]);
  });
});

describe('SocialNode: offline and own devices', () => {
  it('queues messages while offline and sends them later', async () => {
    const w = world();
    const flaky = new FlakyTransport(w.net, LISA, w.now);
    const lisa = w.make(LISA, 'Lisa', { transport: flaky });
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    flaky.offline = true;
    await lisa.sendChat(MAX, 'kommt später an');
    expect(lisa.getState().outbox).toHaveLength(1);
    const got: string[] = [];
    max.on((e) => e.type === 'chat' && got.push(e.entry.text));
    flaky.offline = false;
    w.tick(20_000);
    await lisa.tick();
    await flush();
    expect(got).toEqual(['kommt später an']);
    expect(lisa.getState().outbox).toEqual([]);
  });

  it('links a second device, which then gets messages, settings and sent chats', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);

    // The new device shows its code and listens on a one-time key.
    const invite = { tempKey: TEMP, relays: RELAY, nonce: 'n'.repeat(20), expiresAt: w.now() + 600_000 };
    const temp = w.net.createTransport(TEMP, w.now);
    const receiver = new LinkReceiver(invite, (s) => (s === LISA_SECRET ? LISA : 'x'));
    let payload: ReturnType<LinkReceiver['handle']>;
    temp.onMessage((m) => (payload = receiver.handle(m, w.now()) ?? payload));
    await temp.start();

    const code = encodeLinkInvite(invite);
    expect(lisa.previewLink(code)).toEqual({ ok: true, code: expect.stringMatching(/^\d{3} \d{3}$/) });
    await lisa.sendLink(code, LISA_SECRET);
    await flush();
    expect(payload!.accountKey).toBe(LISA);

    const desktop = w.make(LISA, 'Lisa', {
      initial: createLinkedState(payload!, { deviceId: 'dev-desktop-1', deviceName: 'PC' }, w.now()),
    });
    await desktop.start();
    expect(desktop.getState().contacts.map((c) => c.name)).toEqual(['Max']);
    await desktop.announceLinked();
    await flush();
    expect(lisa.getState().devices.map((d) => d.name)).toEqual(['PC']);

    // Settings changed on the phone reach the desktop.
    lisa.setSosMessage('Ruf 112');
    await lisa.flushSync();
    await flush();
    expect(desktop.getState().sosMessage).toBe('Ruf 112');

    // A chat sent from the phone shows up on the desktop, and Max's answer reaches both.
    const desktopChats: string[] = [];
    desktop.on((e) => e.type === 'chat' && desktopChats.push(`${e.entry.from === 'me' ? 'ich' : 'max'}: ${e.entry.text}`));
    await lisa.sendChat(MAX, 'Hallo vom Handy');
    await max.sendChat(LISA, 'Hallo zurück');
    await flush();
    expect(desktopChats).toEqual(['ich: Hallo vom Handy', 'max: Hallo zurück']);
  });

  it('refuses a linked account that does not belong to the sender', async () => {
    const w = world();
    const invite = { tempKey: TEMP, relays: RELAY, nonce: 'n'.repeat(20), expiresAt: w.now() + 600_000 };
    const receiver = new LinkReceiver(invite, () => MAX); // the secret belongs to Max, not to the sender
    const mallory = w.make(MALLORY, 'Mallory');
    const temp = w.net.createTransport(TEMP, w.now);
    let got: unknown;
    temp.onMessage((m) => (got = receiver.handle(m, w.now()) ?? got));
    await temp.start();
    await mallory.sendLink(encodeLinkInvite(invite), 'b'.repeat(64));
    await flush();
    expect(got).toBeUndefined();
  });
});
