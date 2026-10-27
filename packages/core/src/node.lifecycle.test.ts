import { describe, expect, it } from 'vitest';
import type { Rule } from './automation/schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './automation/templates';
import { backupState, restoredState } from './backup/backup';
import { SocialNode, type NodeEvent } from './node';
import type { AppMessage, AppMessageBody } from './protocol/messages';
import { composeMessage } from './protocol/compose';
import { createInitialState, type Alert, type Contact, type NodeState } from './state';
import { buildSyncDoc } from './sync/doc';
import { createLinkedState } from './sync/receiver';
import { MemoryNetwork, MemoryTransport } from './transport/memory';
import type { SendOptions } from './transport/transport';

/**
 * Regression tests for removing contacts (here or on another of my devices), stopping a trip,
 * and devices that just got the account by linking or restoring a backup. Each one first
 * reproduced the problem before it was fixed.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const MIA = '4'.repeat(64);
const RELAY = ['wss://relay.example'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function state(key: string, name: string, deviceId = `dev-${name}-00`): NodeState {
  return createInitialState({ key, name, relays: RELAY, deviceId, deviceName: `${name}s Handy` });
}

const contact = (key: string, name: string): Contact => ({ key, name, relays: RELAY, addedAt: 0, verified: true });

const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

function rule(id: string, values: Record<string, string | number>): Rule {
  const r = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === id)!, values);
  if (!r.ok) throw new Error(r.errors.join(', '));
  return r.value;
}

/** A transport whose sending fails while `offline`, like a phone in a tunnel; receiving still works. */
function flakyTransport(net: MemoryNetwork, key: string, now: () => number): MemoryTransport & { offline: boolean } {
  const t = Object.assign(net.createTransport(key, now), { offline: false });
  const send = t.send.bind(t);
  t.send = async (to: string, message: AppMessage, options?: SendOptions) => {
    if (t.offline) throw new Error('offline');
    return send(to, message, options);
  };
  return t;
}

function world() {
  let clock = 30 * DAY;
  const now = () => clock;
  const net = new MemoryNetwork();
  const make = (key: string, name: string, opts: { transport?: MemoryTransport; initial?: NodeState } = {}) =>
    new SocialNode({
      transport: opts.transport ?? net.createTransport(key, now),
      initialState: opts.initial ?? state(key, name),
      now,
      localTime,
      syncDelayMs: 0,
    });
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
  /** Types of the messages that went from `from` to `to` since `since` (an index into the log). */
  const sent = (from: string, to: string, since = 0) => net.log.slice(since).filter((l) => l.from === from && l.to === to).map((l) => l.message.type);
  return { net, now, tick: (ms: number) => (clock += ms), make, pair, forge, sent };
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

/** Lisa's new PC, which just got her account; Max and Mia are her contacts. */
async function freshDevice() {
  const w = world();
  const pc = w.make(LISA, 'Lisa', {
    initial: { ...state(LISA, 'Lisa', 'dev-pc-0001'), contacts: [contact(MAX, 'Max'), contact(MIA, 'Mia')], historyBefore: w.now() },
  });
  await pc.start();
  return { ...w, pc, fromMax: w.forge(MAX) };
}

describe('a device that just got the account (linked or restored)', () => {
  it('rings nothing for an SOS that ended before, whatever order the relays hand it over in', async () => {
    const { pc, now, tick, fromMax } = await freshDevice();
    const got = alerts(pc);
    const sosId = 'sos-max-000001';
    // Relays hand stored messages over in any order: here the start before its end.
    await fromMax(LISA, { type: 'sos.start', sosId, text: 'Unfall', others: [] }, now() - 2 * DAY);
    await fromMax(LISA, { type: 'sos.end', sosId, reason: 'safe' }, now() - 2 * DAY + 10 * MIN);
    expect(pc.getStatus(MAX).sos?.endedAt).toBeDefined();
    tick(5 * MIN);
    await pc.tick();
    expect(got).toEqual([]);
  });

  it('does not call off an SOS from before whose alarm never rang here when it ends after the link', async () => {
    const { pc, now, fromMax } = await freshDevice();
    const got = alerts(pc);
    await fromMax(LISA, { type: 'sos.start', sosId: 'sos-max-000005', text: 'Unfall', others: [] }, now() - HOUR);
    await fromMax(LISA, { type: 'sos.end', sosId: 'sos-max-000005', reason: 'safe' }, now());
    expect(pc.getStatus(MAX).sos?.endReason).toBe('safe');
    expect(got).toEqual([]);
  });

  it('rings an SOS from before that is still open, once, after waiting for its end a moment', async () => {
    const { pc, now, tick, fromMax } = await freshDevice();
    const got = alerts(pc);
    await fromMax(LISA, { type: 'sos.start', sosId: 'sos-max-000002', text: 'Hilfe', others: [] }, now() - HOUR);
    expect(pc.getStatus(MAX).sos?.text).toBe('Hilfe');
    await pc.tick();
    expect(got).toEqual([]);
    tick(3 * MIN);
    await pc.tick();
    await pc.tick();
    expect(got.map((a) => [a.level, a.id, a.title])).toEqual([['alarm', `sos:${MAX}:sos-max-000002`, '🆘 Max braucht Hilfe!']]);
  });

  it('rings an SOS from before at once when it is pressed again after the link', async () => {
    const { pc, now, fromMax } = await freshDevice();
    const got = alerts(pc);
    await fromMax(LISA, { type: 'sos.start', sosId: 'sos-max-000004', text: 'Hilfe', others: [] }, now() - HOUR);
    await fromMax(LISA, { type: 'sos.start', sosId: 'sos-max-000004', text: 'Immer noch Hilfe', others: [] }, now());
    expect(got.map((a) => [a.level, a.body])).toEqual([['alarm', 'Immer noch Hilfe']]);
    await pc.tick();
    expect(got).toHaveLength(1);
  });

  it('forgets an SOS from before that is older than an open SOS is kept', async () => {
    const { pc, now, tick, fromMax } = await freshDevice();
    const got = alerts(pc);
    await fromMax(LISA, { type: 'sos.start', sosId: 'sos-max-000003', others: [] }, now() - 4 * DAY);
    tick(3 * MIN);
    await pc.tick();
    expect(pc.getStatus(MAX).sos).toBeUndefined();
    expect(got).toEqual([]);
  });

  it('keeps watches from before: a running one still rings at its time, an ended one never', async () => {
    const { pc, now, tick, fromMax } = await freshDevice();
    const got = alerts(pc);
    const evs = events(pc);
    await fromMax(LISA, { type: 'watch.start', watchId: 'watch-max-0001', label: 'Heimweg', dueAt: now() + HOUR }, now() - HOUR);
    await fromMax(LISA, { type: 'watch.start', watchId: 'watch-max-0002', label: 'Wandern', dueAt: now() - HOUR }, now() - 3 * HOUR);
    await fromMax(LISA, { type: 'watch.end', watchId: 'watch-max-0002', reason: 'ok' }, now() - 2 * HOUR);
    expect(got).toEqual([]);
    expect(evs.flatMap((e) => (e.type === 'alarm.schedule' ? [e.alarm.id] : []))).toContain(`watch:${MAX}:watch-max-0001`);
    tick(HOUR + MIN);
    await pc.tick();
    expect(got.map((a) => [a.category, a.ref?.watchId])).toEqual([['watch', 'watch-max-0001']]);
  });

  it('fills in chats and statuses from before without notifications, automations or open questions', async () => {
    const { pc, net, now, fromMax, sent } = await freshDevice();
    pc.setRules([rule('core.checkin-heart', { contact: MAX })]);
    const got = alerts(pc);
    const chats: string[] = [];
    pc.on((e) => e.type === 'chat' && chats.push(e.entry.text));
    const before = net.log.length;
    const old = now() - DAY;
    await fromMax(LISA, { type: 'chat.text', text: 'Hallo von gestern', urgent: true }, old);
    await fromMax(LISA, { type: 'checkin', kind: 'arrived' }, old + MIN);
    await fromMax(LISA, { type: 'where.request', requestId: 'where-max-00001' }, old + 2 * MIN);
    await fromMax(LISA, { type: 'session.start', sessionId: 'trip-max-000001', destinationName: 'Kino', level: 'eta', expiresAt: now() + HOUR }, old + 3 * MIN);
    await fromMax(LISA, { type: 'place.event', kind: 'arrive', placeName: 'Zuhause' }, old + 4 * MIN);
    expect(chats).toEqual(['Hallo von gestern', expect.stringContaining('angekommen'), '📍 Wo bist du?']);
    expect(pc.getStatus(MAX).lastPlace?.placeName).toBe('Zuhause');
    expect(pc.getStatus(MAX).trip?.destinationName).toBe('Kino');
    expect(pc.getState().whereInbox).toEqual([]);
    expect(got).toEqual([]);
    expect(sent(LISA, MAX, before)).toEqual([]);

    // What comes after the link is news again: it notifies and runs automations.
    await fromMax(LISA, { type: 'chat.text', text: 'Und jetzt?' }, now());
    await fromMax(LISA, { type: 'checkin', kind: 'arrived' }, now());
    await fromMax(LISA, { type: 'where.request', requestId: 'where-max-00002' }, now());
    expect(got.map((a) => a.category)).toEqual(['chat', 'checkin', 'where']);
    expect(pc.getState().whereInbox.map((w) => w.requestId)).toEqual(['where-max-00002']);
    expect(sent(LISA, MAX, before)).toEqual(['ping']);
  });

  it('does not let old questions and urgent messages use up the limits for new ones', async () => {
    const { pc, now, fromMax } = await freshDevice();
    const got = alerts(pc);
    const urgent: boolean[] = [];
    pc.on((e) => e.type === 'chat' && e.entry.kind === 'text' && urgent.push(e.entry.urgent === true));
    for (let i = 0; i < 6; i++) await fromMax(LISA, { type: 'where.request', requestId: `where-old-0000${i}` }, now() - DAY + i * MIN);
    for (let i = 0; i < 4; i++) await fromMax(LISA, { type: 'chat.text', text: `alt ${i}`, urgent: true }, now() - DAY + i * MIN);
    await fromMax(LISA, { type: 'where.request', requestId: 'where-new-00001' }, now());
    await fromMax(LISA, { type: 'chat.text', text: 'neu', urgent: true }, now());
    expect(got.map((a) => a.category)).toEqual(['where', 'chat']);
    expect(urgent.at(-1)).toBe(true);
  });

  it('still counts messages sent shortly before as new, so a sender whose clock lags a little loses nothing', async () => {
    const { pc, now, fromMax } = await freshDevice();
    const got = alerts(pc);
    await fromMax(LISA, { type: 'chat.text', text: 'gerade eben' }, now() - 2 * MIN);
    expect(got.map((a) => a.body)).toEqual(['gerade eben']);
  });

  it('treats every message as new once its clock reads earlier than when it got the account (set back since)', async () => {
    const w = world();
    const pc = w.make(LISA, 'Lisa', { initial: { ...state(LISA, 'Lisa'), contacts: [contact(MAX, 'Max')], historyBefore: w.now() + 30 * DAY } });
    await pc.start();
    const got = alerts(pc);
    await w.forge(MAX)(LISA, { type: 'chat.text', text: 'Hallo' }, w.now());
    expect(got.map((a) => a.body)).toEqual(['Hallo']);
  });

  it('a linked device knows when it got the account', () => {
    const lisa = state(LISA, 'Lisa');
    const at = 30 * DAY;
    const linked = createLinkedState(
      { accountKey: LISA, secretKey: 'a'.repeat(64), relays: RELAY, deviceId: 'dev-phone-01', deviceName: 'Handy', devices: [], doc: buildSyncDoc({ ...lisa, contacts: [contact(MAX, 'Max')] }) },
      { deviceId: 'dev-pc-00001', deviceName: 'PC' },
      at,
    );
    expect(linked.historyBefore).toBe(at);
  });
});

/** Like the relay transport: delivers at once, and says when its first catch-up is done (`finishCatchUp`). */
function catchUpTransport(net: MemoryNetwork, key: string, now: () => number) {
  const t = net.createTransport(key, now);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return Object.assign(t, { caughtUp: () => done, finishCatchUp: () => finish() });
}

describe('a device that just got the account: its first catch-up', () => {
  async function linkedPc() {
    const w = world();
    const relay = catchUpTransport(w.net, LISA, w.now);
    const pc = w.make(LISA, 'Lisa', {
      transport: relay,
      initial: { ...state(LISA, 'Lisa', 'dev-pc-0001'), contacts: [contact(MAX, 'Max')], historyBefore: w.now() },
    });
    const got = alerts(pc);
    await pc.start();
    const caughtUp = async () => {
      relay.finishCatchUp();
      await flush();
    };
    return { ...w, pc, got, caughtUp, fromMax: w.forge(MAX) };
  }

  it('only what comes during it is history: a message written before the link that arrives later notifies', async () => {
    const { pc, got, now, caughtUp, fromMax } = await linkedPc();
    await fromMax(LISA, { type: 'chat.text', text: 'von gestern' }, now() - DAY);
    expect(got).toEqual([]);
    await caughtUp();
    // Max wrote this before the link while he was offline; it reaches the relays only now.
    await fromMax(LISA, { type: 'chat.text', text: 'aus dem Funkloch' }, now() - 2 * HOUR);
    expect(got.map((a) => a.body)).toEqual(['aus dem Funkloch']);
    expect(pc.getState().historyBefore).toBeUndefined();
  });

  it('a contact whose clock runs behind gets their first messages after the link through', async () => {
    const { got, now, tick, caughtUp, fromMax } = await linkedPc();
    await caughtUp();
    tick(MIN);
    await fromMax(LISA, { type: 'chat.text', text: 'Hallo' }, now() - 12 * MIN);
    expect(got.map((a) => a.body)).toEqual(['Hallo']);
  });

  it('a catch-up cut short (the app was closed) still counts as the first one on the next start', async () => {
    const w = world();
    const first = catchUpTransport(w.net, LISA, w.now);
    const pc = w.make(LISA, 'Lisa', { transport: first, initial: { ...state(LISA, 'Lisa', 'dev-pc-0001'), contacts: [contact(MAX, 'Max')], historyBefore: w.now() } });
    await pc.start();
    await pc.stop();
    expect(pc.getState().historyBefore).toBe(w.now());
    const second = catchUpTransport(w.net, LISA, w.now);
    const again = w.make(LISA, 'Lisa', { transport: second, initial: pc.getState() });
    const got = alerts(again);
    await again.start();
    await w.forge(MAX)(LISA, { type: 'chat.text', text: 'von gestern' }, w.now() - DAY);
    expect(got).toEqual([]);
    second.finishCatchUp();
    await flush();
    expect(again.getState().historyBefore).toBeUndefined();
  });

  it('an SOS from before that is still open rings right after it, once, as an alarm even in quiet mode', async () => {
    const { pc, got, now, tick, caughtUp, fromMax } = await linkedPc();
    await pc.setDnd(undefined);
    await fromMax(LISA, { type: 'sos.start', sosId: 'sos-max-000010', text: 'Hilfe', others: [] }, now() - HOUR);
    expect(got).toEqual([]);
    await caughtUp();
    expect(got.map((a) => [a.level, a.id, a.title])).toEqual([['alarm', `sos:${MAX}:sos-max-000010`, '🆘 Max braucht Hilfe!']]);
    tick(5 * MIN);
    await pc.tick();
    await pc.tick();
    expect(got).toHaveLength(1);
    // Not again after a restart either.
    const again = new SocialNode({ transport: w2(pc), initialState: pc.getState(), initialStatuses: pc.exportStatuses(), now, localTime, syncDelayMs: 0 });
    const more = alerts(again);
    await again.start();
    await again.tick();
    expect(more).toEqual([]);
  });

  it('an SOS from before that ended during it rings nothing', async () => {
    const { got, now, caughtUp, fromMax } = await linkedPc();
    await fromMax(LISA, { type: 'sos.end', sosId: 'sos-max-000011', reason: 'safe' }, now() - HOUR + 5 * MIN);
    await fromMax(LISA, { type: 'sos.start', sosId: 'sos-max-000011', text: 'Hilfe', others: [] }, now() - HOUR);
    await caughtUp();
    expect(got).toEqual([]);
  });

  it('an overdue watch from before with no end rings once after it, at its proper level', async () => {
    const { pc, got, now, tick, caughtUp, fromMax } = await linkedPc();
    await pc.setDnd(undefined);
    await fromMax(LISA, { type: 'watch.start', watchId: 'watch-max-0010', label: 'Heimweg', dueAt: now() - 30 * MIN }, now() - 2 * HOUR);
    await caughtUp();
    tick(3 * MIN);
    await pc.tick();
    await pc.tick();
    expect(got.map((a) => [a.category, a.level, a.ref?.watchId])).toEqual([['watch', 'alarm', 'watch-max-0010']]);
  });
});

/** A plain transport for the same account, for a restart in a test. */
function w2(node: SocialNode): MemoryTransport {
  return new MemoryNetwork().createTransport(node.getState().self.key);
}

describe('restoring a backup', () => {
  it('a backup keeps no running live share, SOS or anything waiting to go out', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    lisa.updateContact(MAX, { emergency: true });
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await lisa.startSos({ text: 'Hilfe' });
    const s = backupState(lisa.getState());
    expect(s.liveShares).toEqual([]);
    expect(s.sos).toBeUndefined();
    expect(s.outbox).toEqual([]);
    expect(s.contacts.map((c) => c.key)).toEqual([MAX]);
  });

  it('a live share in an older backup file ends for the contact on the first start instead of sending location again', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    lisa.updateContact(MAX, { emergency: true });
    await lisa.startLive({ contacts: [MAX], level: 'coarse' });
    await lisa.onLocationFix({ ...home, timestamp: w.now(), accuracyM: 10 });
    await flush();
    // A backup file made by an older version: the share and the SOS were still in it.
    const old = JSON.parse(JSON.stringify(lisa.getState())) as NodeState;
    old.sos = { sosId: 'old-sos-00001', startedAt: w.now(), recipients: [MAX], locationUntil: w.now() + HOUR, acks: [] };
    await lisa.stop();
    expect(max.getStatus(LISA).live?.cell).toBeDefined();

    w.tick(20 * DAY);
    const restored = restoredState({ ...old, self: { ...old.self, deviceId: 'dev-new-phone1', deviceName: 'Neues Handy' } }, w.now());
    expect(restored.liveShares).toEqual([]);
    expect(restored.sos).toBeUndefined();
    expect(restored.historyBefore).toBe(w.now());
    const phone = w.make(LISA, 'Lisa', { initial: restored });
    const before = w.net.log.length;
    await phone.start();
    expect(phone.locationNeeds().mode).toBe('off');
    await phone.tick();
    await phone.onLocationFix({ ...north(5000), timestamp: w.now(), accuracyM: 10 });
    await flush();
    expect(w.sent(LISA, MAX, before)).toEqual(['live.end']);
    expect(max.getStatus(LISA).live).toBeUndefined();
  });
});

describe('removing a contact', () => {
  it('ends my watch, SOS and trip on their phone, so nothing stays open there and no alarm rings later', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    lisa.updateContact(MAX, { emergency: true });
    await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + HOUR });
    await lisa.startSos({ text: 'Hilfe' });
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Zuhause' });
    await flush();
    expect(max.getStatus(LISA).watches).toHaveLength(1);
    const maxEvents = events(max);
    const maxAlerts = alerts(max);

    await lisa.removeContact(MAX);
    await flush();
    expect(max.getStatus(LISA).sos?.endedAt).toBeDefined();
    expect(max.getStatus(LISA).watches ?? []).toEqual([]);
    expect(max.getStatus(LISA).trip).toBeUndefined();
    expect(maxEvents.some((e) => e.type === 'alarm.cancel' && e.id.startsWith(`watch:${LISA}:`))).toBe(true);
    // Nobody is left to get them: they end on Lisa's phone too.
    expect(lisa.getState().sos).toBeUndefined();
    expect(lisa.getState().watches).toEqual([]);
    expect(lisa.activeTrip).toBeUndefined();

    w.tick(HOUR + MIN);
    await max.tick();
    expect(maxAlerts.filter((a) => a.category === 'watch')).toEqual([]);
  });

  it('during my SOS, tells someone I remove that they get no more updates, not that the emergency is over', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const mia = w.make(MIA, 'Mia');
    for (const n of [lisa, max, mia]) await n.start();
    await w.pair(lisa, max);
    await w.pair(lisa, mia);
    lisa.updateContact(MAX, { emergency: true });
    lisa.updateContact(MIA, { emergency: true });
    await lisa.startSos({ text: 'Hilfe' });
    await flush();
    const maxAlerts = alerts(max);
    const miaAlerts = alerts(mia);

    await lisa.removeContact(MAX);
    await flush();
    expect(max.getStatus(LISA).sos?.endReason).toBe('removed');
    expect(maxAlerts.map((a) => [a.category, a.level, a.title, a.body])).toEqual([
      ['sos', 'normal', 'Lisa: keine Notruf-Updates mehr', 'Du bekommst von Lisa keine Notruf-Updates mehr. Ob der Notruf vorbei ist, weißt du damit nicht.'],
    ]);
    expect(maxAlerts.some((a) => /abgebrochen|beendet|Sicherheit/.test(`${a.title} ${a.body}`))).toBe(false);
    // Still running for Mia; an end as before still reads as before.
    expect(mia.getStatus(LISA).sos?.endedAt).toBeUndefined();
    await lisa.endSos('cancelled');
    await flush();
    expect(miaAlerts.map((a) => a.title)).toEqual(['Lisa hat den Notruf abgebrochen']);
  });

  it('keeps my watch, SOS and trip running for the others', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const mia = w.make(MIA, 'Mia');
    await lisa.start();
    await max.start();
    await mia.start();
    await w.pair(lisa, max);
    await w.pair(lisa, mia);
    lisa.updateContact(MAX, { emergency: true });
    lisa.updateContact(MIA, { emergency: true });
    await lisa.startWatch({ to: [MAX, MIA], label: 'Heimweg', dueAt: w.now() + HOUR });
    await lisa.startSos({ text: 'Hilfe' });
    await lisa.startTrip({ recipients: [MAX, MIA], destinationName: 'Zuhause' });
    await flush();

    await lisa.removeContact(MAX);
    await flush();
    expect(lisa.getState().sos?.recipients).toEqual([MIA]);
    expect(lisa.getState().watches.map((x) => x.recipients)).toEqual([[MIA]]);
    expect(lisa.activeTrip?.recipients).toEqual([MIA]);
    expect(mia.getStatus(LISA).sos?.endedAt).toBeUndefined();
    expect(mia.getStatus(LISA).watches).toHaveLength(1);
    expect(mia.getStatus(LISA).trip?.destinationName).toBe('Zuhause');
  });

  it('drops what is still queued for them, and their phone still learns that my live share ended', async () => {
    const w = world();
    const flaky = flakyTransport(w.net, LISA, w.now);
    const lisa = w.make(LISA, 'Lisa', { transport: flaky });
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    lisa.updateContact(MAX, { emergency: true });
    await lisa.startLive({ contacts: [MAX], level: 'precise' });
    await flush();
    flaky.offline = true;
    w.tick(MIN);
    await lisa.onLocationFix({ ...north(500), timestamp: w.now(), accuracyM: 5 });
    await lisa.startSos({ text: 'Hilfe' });
    await lisa.sendChat(MAX, 'noch nicht raus');

    await lisa.removeContact(MAX);
    expect(lisa.getState().outbox.map((e) => e.message.type).sort()).toEqual(['live.end', 'sos.end']);
    flaky.offline = false;
    const before = w.net.log.length;
    w.tick(MIN);
    await lisa.flushOutbox(true);
    await flush();
    expect(w.sent(LISA, MAX, before).sort()).toEqual(['live.end', 'sos.end']);
    expect(max.getStatus(LISA).live).toBeUndefined();
  });

  it('still sends an end that was waiting in the outbox before the removal', async () => {
    const w = world();
    const flaky = flakyTransport(w.net, LISA, w.now);
    const lisa = w.make(LISA, 'Lisa', { transport: flaky });
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    lisa.updateContact(MAX, { emergency: true });
    await lisa.startSos({ text: 'Hilfe' });
    await flush();
    flaky.offline = true;
    await lisa.endSos('safe');
    await lisa.removeContact(MAX);
    flaky.offline = false;
    w.tick(MIN);
    await lisa.flushOutbox(true);
    await flush();
    expect(max.getStatus(LISA).sos?.endReason).toBe('safe');
  });

  it('on my other device too: it drops location queued for them and ends its live share, watch and SOS there', async () => {
    const w = world();
    const phoneT = flakyTransport(w.net, LISA, w.now);
    const phone = w.make(LISA, 'Lisa', {
      transport: phoneT,
      initial: { ...state(LISA, 'Lisa', 'dev-phone-01'), devices: [{ deviceId: 'dev-desk-001', name: 'PC', linkedAt: 0 }] },
    });
    const desk = w.make(LISA, 'Lisa', {
      initial: { ...state(LISA, 'Lisa', 'dev-desk-001'), devices: [{ deviceId: 'dev-phone-01', name: 'Handy', linkedAt: 0 }] },
    });
    const max = w.make(MAX, 'Max');
    await phone.start();
    await desk.start();
    await max.start();
    await w.pair(phone, max);
    await phone.flushSync();
    await flush();
    expect(desk.getState().contacts.map((c) => c.key)).toEqual([MAX]);
    phone.updateContact(MAX, { emergency: true });
    await phone.startLive({ contacts: [MAX], level: 'precise' });
    await phone.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + HOUR });
    await flush();
    const maxAlerts = alerts(max);

    // The phone is in a tunnel: its next position waits in the outbox. Lisa removes Max on her PC.
    phoneT.offline = true;
    w.tick(MIN);
    await phone.onLocationFix({ ...north(500), timestamp: w.now(), accuracyM: 5 });
    expect(phone.getState().outbox.map((e) => e.message.type)).toContain('live.update');
    await desk.removeContact(MAX);
    await desk.flushSync();
    await flush();
    expect(phone.getState().contacts).toEqual([]);
    expect(phone.getState().liveShares).toEqual([]);
    expect(phone.getState().watches).toEqual([]);
    expect(phone.getState().outbox.map((e) => e.message.type).sort()).toEqual(['live.end', 'watch.end']);

    phoneT.offline = false;
    const before = w.net.log.length;
    w.tick(MIN);
    await phone.flushOutbox(true);
    await flush();
    expect(w.sent(LISA, MAX, before).sort()).toEqual(['live.end', 'watch.end']);
    expect(max.getStatus(LISA).live).toBeUndefined();
    w.tick(HOUR);
    await max.tick();
    expect(maxAlerts.filter((a) => a.category === 'watch')).toEqual([]);
  });

  it('never sends location queued for someone who is no longer a contact', async () => {
    const w = world();
    const max = w.make(MAX, 'Max');
    await max.start();
    const queued = (body: AppMessageBody) => ({ to: MAX, message: composeMessage(body, w.now()), ttlSeconds: 3600, firstAt: w.now(), attempts: 1 });
    const lisa = w.make(LISA, 'Lisa', {
      initial: {
        ...state(LISA, 'Lisa'),
        outbox: [
          queued({ type: 'live.update', shareId: 'share-000001', point: { ...home, accuracyM: 5 } }),
          queued({ type: 'where.reply', requestId: 'where-000001', answer: 'precise', point: { ...home, accuracyM: 5 } }),
          queued({ type: 'live.end', shareId: 'share-000001', reason: 'stopped' }),
        ],
      },
    });
    await lisa.start();
    const before = w.net.log.length;
    await lisa.flushOutbox(true);
    expect(w.sent(LISA, MAX, before)).toEqual(['live.end']);
    expect(lisa.getState().outbox).toEqual([]);
  });
});

describe('stopping a trip', () => {
  it('drops its queued exact position, so only the end goes out', async () => {
    const w = world();
    const flaky = flakyTransport(w.net, LISA, w.now);
    const lisa = w.make(LISA, 'Lisa', { transport: flaky });
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Zuhause', destination: north(5000), level: 'precise' });
    await flush();
    flaky.offline = true;
    w.tick(MIN);
    await lisa.onLocationFix({ ...north(500), timestamp: w.now(), accuracyM: 5 });
    expect(lisa.getState().outbox.map((e) => e.message.type)).toEqual(['session.update']);

    await lisa.stopTrip();
    expect(lisa.getState().outbox.map((e) => e.message.type)).toEqual(['session.end']);
    flaky.offline = false;
    const before = w.net.log.length;
    w.tick(MIN);
    await lisa.flushOutbox(true);
    await flush();
    expect(w.sent(LISA, MAX, before)).toEqual(['session.end']);
    expect(max.getStatus(LISA).trip).toBeUndefined();
  });

  it('drops its queued position when it runs out too', async () => {
    const w = world();
    const flaky = flakyTransport(w.net, LISA, w.now);
    const lisa = w.make(LISA, 'Lisa', { transport: flaky });
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    await lisa.startTrip({ recipients: [MAX], destinationName: 'Zuhause', destination: north(5000), level: 'precise', durationMs: 10 * MIN });
    await flush();
    flaky.offline = true;
    w.tick(MIN);
    await lisa.onLocationFix({ ...north(500), timestamp: w.now(), accuracyM: 5 });
    w.tick(10 * MIN);
    await lisa.tick();
    expect(lisa.getState().outbox.map((e) => e.message.type)).toEqual(['session.end']);
  });

  it('drops its queued position when the app restarts after it ran out', async () => {
    const w = world();
    const flaky = flakyTransport(w.net, LISA, w.now);
    const lisa = w.make(LISA, 'Lisa', { transport: flaky });
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await w.pair(lisa, max);
    const session = await lisa.startTrip({ recipients: [MAX], destinationName: 'Zuhause', destination: north(5000), level: 'precise', durationMs: 10 * MIN });
    await flush();
    flaky.offline = true;
    w.tick(MIN);
    await lisa.onLocationFix({ ...north(500), timestamp: w.now(), accuracyM: 5 });
    const saved = JSON.parse(JSON.stringify(lisa.getState())) as NodeState;
    await lisa.stop();
    expect(saved.outbox.map((e) => e.message.type)).toEqual(['session.update']);

    // The OS killed the app; it starts again after the trip ran out.
    w.tick(HOUR);
    const again = w.make(LISA, 'Lisa', { initial: saved });
    await again.start();
    expect(again.resumeTrip(session)).toBe(false);
    const before = w.net.log.length;
    await again.tick();
    expect(w.sent(LISA, MAX, before)).toEqual([]);
    expect(again.getState().outbox).toEqual([]);
  });
});
