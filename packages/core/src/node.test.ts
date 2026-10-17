import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it, vi } from 'vitest';
import type { Rule } from './automation/schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './automation/templates';
import { SocialNode, TTL, type NodeEvent } from './node';
import { createInitialState, type Alert, type NodeState } from './state';
import { composeMessage } from './protocol/compose';
import { encodeLinkInvite, LINK_TTL_MS, linkCommitment } from './sync/link';
import { createLinkedState, LinkReceiver, type LinkPayload } from './sync/receiver';
import { base64urlEncode } from './util/base64url';
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
    expect(lisa.getState().sos?.pointSentAt).toBe(now());
    expect(lisa.locationNeeds().mode).toBe('high');

    // Max takes care; Lisa and Mia (another helper) both learn it, as news, not a second alarm.
    const lisaGot = alerts(lisa);
    const miaGot = alerts(mia);
    await max.ackSos(LISA, 'Bin in 5 min da');
    await flush();
    expect(lisa.getState().sos?.acks.map((a) => a.key)).toEqual([MAX]);
    expect(mia.getStatus(LISA).sos?.acks.map((a) => a.name)).toEqual(['Max']);
    expect(lisaGot.at(-1)).toMatchObject({ category: 'sos', level: 'normal', ref: { sosOwner: LISA } });
    expect(miaGot.at(-1)).toMatchObject({ category: 'sos', level: 'normal', ref: { sosOwner: LISA } });

    // Even in quiet mode with Lisa muted, Max hears that she is safe, without an alarm.
    await lisa.endSos('safe');
    await flush();
    expect(max.getStatus(LISA).sos?.endReason).toBe('safe');
    expect(got.at(-1)).toMatchObject({ category: 'sos', level: 'normal' });
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

  it('records that no location went out when there was no fix', async () => {
    const { lisa } = await pairedPair();
    lisa.updateContact(MAX, { emergency: true });
    await lisa.startSos();
    expect(lisa.getState().sos?.pointSentAt).toBeUndefined();
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

  it('has its transport hand on refused messages again once it learns new members or contacts', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const redeliver = vi.fn();
    const max = w.make(MAX, 'Max', { transport: Object.assign(w.net.createTransport(MAX, w.now), { redeliverRefused: redeliver }) });
    const mia = w.make(MIA, 'Mia');
    for (const n of [lisa, max, mia]) await n.start();
    await w.pair(lisa, mia);
    await w.pair(lisa, max);
    expect(redeliver).toHaveBeenCalled();
    redeliver.mockClear();

    // Mia's first group message can reach Max before the update that makes her a member of his copy.
    await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    expect(max.getState().groups).toHaveLength(1);
    expect(redeliver).toHaveBeenCalledTimes(1);
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
    // Gone from her list; a hidden copy keeps its version, so Lisa can add her back later.
    expect(mia.getState().groups.filter((g) => !g.dissolved)).toEqual([]);
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
    const n = await newDevice(w);
    await lisa.startLink(n.code);
    await flush();
    expect(n.digits).toMatch(/^\d{3} \d{3}$/);
    expect(lisa.linkStatus).toEqual({ phase: 'compare', code: n.digits, expiresAt: n.invite.expiresAt });
    await lisa.confirmLink(LISA_SECRET);
    await flush();
    expect(n.payload!.accountKey).toBe(LISA);
    expect(lisa.linkStatus).toBeUndefined();

    const desktop = w.make(LISA, 'Lisa', {
      initial: createLinkedState(n.payload!, { deviceId: 'dev-desktop-1', deviceName: 'PC' }, w.now()),
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
    const n = await newDevice(w, { publicKeyOf: () => MAX }); // the secret belongs to Max, not to the sender
    const mallory = w.make(MALLORY, 'Mallory');
    await mallory.start();
    await mallory.startLink(n.code);
    await flush();
    await mallory.confirmLink('b'.repeat(64));
    await flush();
    expect(n.payload).toBeUndefined();
  });
});

/** The new device: shows a code, answers the first hello with its reveal, collects the account. */
async function newDevice(
  w: ReturnType<typeof world>,
  opts: { tempKey?: string; secret?: Uint8Array; nonce?: string; expiresAt?: number; publicKeyOf?: (secretKeyHex: string) => string } = {},
) {
  const secret = opts.secret ?? new Uint8Array(32).fill(7);
  const invite = {
    tempKey: opts.tempKey ?? TEMP,
    relays: RELAY,
    nonce: opts.nonce ?? 'n'.repeat(20),
    expiresAt: opts.expiresAt ?? w.now() + 600_000,
    commit: linkCommitment(secret),
  };
  const transport = w.net.createTransport(invite.tempKey, w.now);
  const receiver = new LinkReceiver(invite, secret, opts.publicKeyOf ?? ((s) => (s === LISA_SECRET ? LISA : 'x')));
  const out = {
    invite,
    secret,
    code: encodeLinkInvite(invite),
    transport,
    receiver,
    digits: undefined as string | undefined,
    payload: undefined as LinkPayload | undefined,
  };
  transport.onMessage((m) => {
    const step = receiver.handle(m, w.now());
    if (step?.type === 'reveal') {
      out.digits = step.code;
      void transport.send(step.to, composeMessage(step.message, w.now()), { ttlSeconds: TTL.link, relays: step.relays });
      // The person sees the same digits here and taps "Zahlen stimmen überein" on this device too.
      const held = receiver.confirmCode();
      if (held?.type === 'payload') out.payload = held.payload;
    } else if (step?.type === 'payload') {
      out.payload = step.payload;
    }
  });
  await transport.start();
  return out;
}

/** Lets a test decide, send by send, whether a message leaves, fails, or leaves and still fails. */
function scriptSends(t: MemoryTransport, decide: (m: AppMessage) => 'ok' | 'fail' | 'lost-ack') {
  const send = t.send.bind(t);
  t.send = async (to, message, options) => {
    const how = decide(message);
    if (how === 'fail') throw new Error('offline');
    await send(to, message, options);
    if (how === 'lost-ack') throw new Error('no answer from the relay');
  };
  return t;
}

/** Makes every "random" byte predictable (and still distinct), so a test can fix all seeds. */
function seededRandom(seed: string) {
  let counter = 0;
  const fill = ((array: ArrayBufferView) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let off = 0; off < bytes.length; off += 32) {
      const block = sha256(new TextEncoder().encode(`${seed}:${counter++}`));
      bytes.set(block.subarray(0, Math.min(32, bytes.length - off)), off);
    }
    return array;
  }) as typeof globalThis.crypto.getRandomValues;
  return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(fill);
}

describe('SocialNode: linking a device with compared digits', () => {
  it('shows nothing to compare until the new device revealed its secret, then the same digits on both', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    const evs = events(lisa);
    const n = await newDevice(w);
    // Hold the reveal back to see the waiting phase.
    n.transport.running = false;
    await lisa.startLink(n.code);
    expect(lisa.linkStatus).toEqual({ phase: 'waiting', expiresAt: n.invite.expiresAt });
    const hello = w.net.log.find((e) => e.message.type === 'link.hello');
    expect(hello?.from).toBe(LISA);
    expect(hello?.to).toBe(TEMP);
    expect(hello?.options).toEqual({ ttlSeconds: TTL.link, relays: RELAY });
    expect(hello?.message).toMatchObject({ nonce: n.invite.nonce, relays: RELAY });
    expect(n.digits).toBeUndefined();

    await n.transport.start();
    await flush();
    expect(n.receiver.peerKey).toBe(LISA);
    expect(lisa.linkStatus).toEqual({ phase: 'compare', code: n.digits, expiresAt: n.invite.expiresAt });
    expect(evs.filter((e) => e.type === 'link').map((e) => e.type === 'link' && e.status?.phase)).toEqual(['waiting', 'compare']);
  });

  it('turns away codes from the old version and broken codes', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    await expect(lisa.startLink('heyda-link:1:eyJ0IjoiYSJ9')).rejects.toThrow('Dieser Code ist von einer älteren Version. Aktualisiere Heyda. auf beiden Geräten.');
    await expect(lisa.startLink('heyda-link:2:%%%')).rejects.toThrow('Der Code ist beschädigt.');
    expect(lisa.linkStatus).toBeUndefined();
    expect(w.net.log.filter((e) => e.message.type === 'link.hello')).toEqual([]);
  });

  it('stops when the reveal does not open the commitment in the code', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    const n = await newDevice(w);
    n.transport.running = false; // the new device stays silent; we answer by hand
    await lisa.startLink(n.code);
    await n.transport.send(LISA, composeMessage({ type: 'link.reveal', nonce: n.invite.nonce, rN: base64urlEncode(new Uint8Array(32).fill(1)) }, w.now()));
    await flush();
    expect(lisa.linkStatus).toBeUndefined();
    await expect(lisa.confirmLink(LISA_SECRET)).rejects.toThrow();
    expect(w.net.log.filter((e) => e.message.type === 'xfer.chunk')).toEqual([]);
  });

  it('ignores reveals from strangers, for another code, or a second time', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    const n = await newDevice(w);
    n.transport.running = false;
    await lisa.startLink(n.code);
    const reveal = (nonce: string) => composeMessage({ type: 'link.reveal', nonce, rN: base64urlEncode(n.secret) }, w.now());

    // Mallory knows everything but cannot send from the one-time key.
    const mallory = w.net.createTransport(MALLORY, w.now);
    expect(lisa.acceptsMessage(MALLORY, reveal(n.invite.nonce))).toBe(false);
    await mallory.send(LISA, reveal(n.invite.nonce));
    // The one-time key, but for another code.
    expect(lisa.acceptsMessage(TEMP, reveal('m'.repeat(20)))).toBe(false);
    await n.transport.send(LISA, reveal('m'.repeat(20)));
    await flush();
    expect(lisa.linkStatus?.phase).toBe('waiting');

    // The one-time key may not use the opening to get anything else in.
    expect(lisa.acceptsMessage(TEMP, composeMessage({ type: 'chat.text', text: 'hi' }, w.now()))).toBe(false);
    expect(lisa.acceptsMessage(TEMP, composeMessage({ type: 'link.hello', nonce: n.invite.nonce, rE: base64urlEncode(n.secret), relays: RELAY }, w.now()))).toBe(false);

    expect(lisa.acceptsMessage(TEMP, reveal(n.invite.nonce))).toBe(true);
    await n.transport.send(LISA, reveal(n.invite.nonce));
    await flush();
    expect(lisa.linkStatus?.phase).toBe('compare');
    const code = lisa.linkStatus?.phase === 'compare' ? lisa.linkStatus.code : '';
    // Once compared, no further reveal is taken (not even a correct one).
    expect(lisa.acceptsMessage(TEMP, reveal(n.invite.nonce))).toBe(false);
    await n.transport.send(LISA, reveal(n.invite.nonce));
    await flush();
    expect(lisa.linkStatus).toEqual({ phase: 'compare', code, expiresAt: n.invite.expiresAt });
  });

  it('refuses to send the account before the digits were compared', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    await expect(lisa.confirmLink(LISA_SECRET)).rejects.toThrow();
    const n = await newDevice(w);
    n.transport.running = false;
    await lisa.startLink(n.code);
    await expect(lisa.confirmLink(LISA_SECRET)).rejects.toThrow();
    expect(w.net.log.filter((e) => e.message.type === 'xfer.chunk')).toEqual([]);
    await n.transport.start();
    await flush();
    await lisa.confirmLink(LISA_SECRET);
    await flush();
    expect(n.payload?.accountKey).toBe(LISA);
    // Only once.
    await expect(lisa.confirmLink(LISA_SECRET)).rejects.toThrow();
  });

  it('keeps one session at a time and forgets it on cancel or expiry', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    const first = await newDevice(w);
    first.transport.running = false;
    await lisa.startLink(first.code);
    const second = await newDevice(w, { tempKey: MIA, nonce: 'o'.repeat(20) });
    second.transport.running = false;
    await lisa.startLink(second.code);
    // The first device's reveal no longer counts.
    await first.transport.start();
    await flush();
    expect(lisa.linkStatus).toEqual({ phase: 'waiting', expiresAt: second.invite.expiresAt });

    lisa.cancelLink();
    expect(lisa.linkStatus).toBeUndefined();
    await second.transport.start();
    await flush();
    expect(lisa.linkStatus).toBeUndefined();

    const third = await newDevice(w, { tempKey: '6'.repeat(64), nonce: 'p'.repeat(20) });
    third.transport.running = false;
    await lisa.startLink(third.code);
    const evs = events(lisa);
    w.tick(600_001);
    expect(lisa.linkStatus).toBeUndefined();
    await lisa.tick();
    expect(evs.filter((e) => e.type === 'link')).toEqual([{ type: 'link', status: undefined }]);
    await third.transport.start();
    await flush();
    expect(lisa.linkStatus).toBeUndefined();
    await expect(lisa.confirmLink(LISA_SECRET)).rejects.toThrow();
  });

  it('scanning the same code twice keeps the session, so both devices still show the same digits', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    const n = await newDevice(w);
    n.transport.running = false;
    await lisa.startLink(n.code);
    // The camera or a second paste delivers the same code again: same share, sent once more.
    await lisa.startLink(` ${n.code}\n`);
    const hellos = w.net.log.filter((e) => e.message.type === 'link.hello').map((e) => e.message);
    expect(hellos).toHaveLength(2);
    expect(hellos[1]).toMatchObject({ nonce: hellos[0]!.type === 'link.hello' && hellos[0]!.nonce, rE: hellos[0]!.type === 'link.hello' && hellos[0]!.rE });
    await n.transport.start();
    await flush();
    expect(n.digits).toMatch(/^\d{3} \d{3}$/);
    expect(lisa.linkStatus).toEqual({ phase: 'compare', code: n.digits, expiresAt: n.invite.expiresAt });
    // Once the digits are there, the same code again changes nothing and sends nothing.
    await lisa.startLink(n.code);
    expect(w.net.log.filter((e) => e.message.type === 'link.hello')).toHaveLength(2);
    expect(lisa.linkStatus).toEqual({ phase: 'compare', code: n.digits, expiresAt: n.invite.expiresAt });
  });

  it('a swapped code gives the attacker one guess at the digits, which fails for fixed seeds', async () => {
    const random = seededRandom('swap');
    try {
      const w = world();
      const lisa = w.make(LISA, 'Lisa');
      await lisa.start();
      // The real new device shows its code; Mallory intercepts it and hands Lisa his own instead.
      const real = await newDevice(w, { secret: new Uint8Array(32).fill(21) });
      const fake = await newDevice(w, { tempKey: MALLORY, nonce: 'm'.repeat(20), secret: new Uint8Array(32).fill(22) });
      await lisa.startLink(fake.code);
      await flush();
      const lisaCode = lisa.linkStatus?.phase === 'compare' ? lisa.linkStatus.code : undefined;
      expect(lisaCode).toBe(fake.digits);

      // Mallory now knows Lisa's digits and tries to get the real device to show the same.
      // He must send his share before he learns the real device's secret ...
      const mallory = w.net.createTransport('7'.repeat(64), w.now);
      await mallory.start();
      const hello = (i: number) =>
        composeMessage({ type: 'link.hello', nonce: real.invite.nonce, rE: base64urlEncode(new Uint8Array(32).fill(i)), relays: RELAY }, w.now());
      await mallory.send(TEMP, hello(1));
      await flush();
      expect(real.receiver.peerKey).toBe('7'.repeat(64));
      expect(real.digits).toMatch(/^\d{3} \d{3}$/);
      expect(real.digits).not.toBe(lisaCode);
      // ... and gets no second try: the real device answers only the first hello.
      const shown = real.digits;
      for (let i = 2; i < 50; i++) await mallory.send(TEMP, hello(i));
      await flush();
      expect(real.digits).toBe(shown);
      expect(w.net.log.filter((e) => e.from === TEMP && e.message.type === 'link.reveal')).toHaveLength(1);
    } finally {
      random.mockRestore();
    }
  });

  it('keeps the session when sending the hello fails, so scanning the same code again still gives the same digits', async () => {
    const w = world();
    let lostAck = true;
    const t = scriptSends(w.net.createTransport(LISA, w.now), (m) => (m.type === 'link.hello' && lostAck ? 'lost-ack' : 'ok'));
    const lisa = w.make(LISA, 'Lisa', { transport: t });
    await lisa.start();
    const n = await newDevice(w);
    n.transport.running = false; // its answer comes late
    // The relay kept the hello, but its OK got lost: the send fails although it arrived.
    await expect(lisa.startLink(n.code)).rejects.toThrow('Keine Verbindung');
    expect(lisa.linkStatus).toEqual({ phase: 'waiting', expiresAt: n.invite.expiresAt });
    lostAck = false;
    await lisa.startLink(n.code);
    const hellos = w.net.log.filter((e) => e.message.type === 'link.hello').map((e) => e.message);
    expect(hellos).toHaveLength(2);
    expect(hellos[1]).toMatchObject({ rE: hellos[0]!.type === 'link.hello' && hellos[0]!.rE });
    await n.transport.start();
    await flush();
    expect(n.digits).toMatch(/^\d{3} \d{3}$/);
    expect(lisa.linkStatus).toEqual({ phase: 'compare', code: n.digits, expiresAt: n.invite.expiresAt });
  });

  it('gets the digits after its first answer got lost, by scanning the same code again', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    const n = await newDevice(w);
    const send = n.transport.send.bind(n.transport);
    let drop = true;
    n.transport.send = async (to, message, options) => {
      if (drop) return; // "sent", but never arrives
      return send(to, message, options);
    };
    await lisa.startLink(n.code);
    await flush();
    expect(n.digits).toMatch(/^\d{3} \d{3}$/);
    expect(lisa.linkStatus?.phase).toBe('waiting');
    drop = false;
    await lisa.startLink(n.code);
    await flush();
    expect(lisa.linkStatus).toEqual({ phase: 'compare', code: n.digits, expiresAt: n.invite.expiresAt });
  });

  it('a retry after a partly failed send fills the same transfer, so the new device still gets the account', async () => {
    const w = world();
    let chunkSends = 0;
    let failOn = new Set<number>();
    const t = scriptSends(w.net.createTransport(LISA, w.now), (m) => (m.type === 'xfer.chunk' && failOn.has(++chunkSends) ? 'fail' : 'ok'));
    // Enough contacts that the account needs more than one chunk.
    const contacts = Array.from({ length: 80 }, (_, i) => ({
      key: 'c'.repeat(62) + i.toString(16).padStart(2, '0'),
      name: `Kontakt ${i} ${'y'.repeat(25)}`,
      relays: RELAY,
      addedAt: 1,
      verified: false,
    }));
    const lisa = w.make(LISA, 'Lisa', { transport: t, initial: { ...state(LISA, 'Lisa'), contacts } });
    await lisa.start();
    const n = await newDevice(w);
    await lisa.startLink(n.code);
    await flush();
    expect(lisa.linkStatus?.phase).toBe('compare');
    // Two attempts each lose the second chunk; the third one gets everything out.
    failOn = new Set([2]);
    await expect(lisa.confirmLink(LISA_SECRET)).rejects.toThrow();
    const perAttempt = chunkSends;
    expect(perAttempt).toBeGreaterThanOrEqual(2);
    failOn = new Set([perAttempt + 2]);
    await expect(lisa.confirmLink(LISA_SECRET)).rejects.toThrow();
    expect(lisa.linkStatus?.phase).toBe('compare');
    failOn = new Set();
    await lisa.confirmLink(LISA_SECRET);
    await flush();
    expect(lisa.linkStatus).toBeUndefined();
    expect(n.payload?.accountKey).toBe(LISA);
    expect(n.payload?.doc.contacts).toHaveLength(80);
    const ids = new Set(w.net.log.flatMap((e) => (e.message.type === 'xfer.chunk' ? [e.message.xferId] : [])));
    expect(ids.size).toBe(1);
  });

  it('ends the session by its own clock, whatever expiry the code claims', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    await lisa.start();
    // The new device's clock runs a day ahead, so its code claims to be valid for a day.
    const n = await newDevice(w, { expiresAt: w.now() + 24 * 3600_000 });
    await lisa.startLink(n.code);
    await flush();
    expect(lisa.linkStatus).toEqual({ phase: 'compare', code: n.digits, expiresAt: w.now() + LINK_TTL_MS });
    w.tick(LINK_TTL_MS);
    expect(lisa.linkStatus).toBeUndefined();
    await expect(lisa.confirmLink(LISA_SECRET)).rejects.toThrow('Die Zeit ist abgelaufen');
    expect(w.net.log.filter((e) => e.message.type === 'xfer.chunk')).toEqual([]);
  });
});
