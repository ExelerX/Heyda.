import { describe, expect, it } from 'vitest';
import type { Rule } from './automation/schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './automation/templates';
import { SocialNode, type NodeEvent } from './node';
import type { AppMessage, AppMessageBody, MessageOf } from './protocol/messages';
import { capGroups, createInitialState, type Alert, type NodeState } from './state';
import { MemoryNetwork, MemoryTransport } from './transport/memory';

/**
 * Regression tests for groups (removing people, adding them back, owners who stopped being a
 * contact) and for check-ins (sent by automations, from another of my devices, with the place
 * I'm at). Each one first reproduced the problem before it was fixed.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const MIA = '4'.repeat(64);
const EVE = '5'.repeat(64);
const TOM = '6'.repeat(64);
const RELAY = ['wss://relay.example'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const home = { lat: 52.52, lon: 13.405 };

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function state(key: string, name: string, deviceId = `dev-${name}-00`): NodeState {
  return createInitialState({ key, name, relays: RELAY, deviceId, deviceName: `${name}s Handy` });
}

const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

function world() {
  let clock = 12 * HOUR;
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
  /** One account on a phone and a PC that know each other as linked devices. */
  const twoDevices = (key: string, name: string) => {
    const phoneT = net.createTransport(key, now);
    const deskT = net.createTransport(key, now);
    const phone = make(key, name, {
      transport: phoneT,
      initial: { ...state(key, name, 'dev-phone-01'), devices: [{ deviceId: 'dev-desk-001', name: 'PC', linkedAt: 0 }] },
    });
    const desk = make(key, name, {
      transport: deskT,
      initial: { ...state(key, name, 'dev-desk-001'), devices: [{ deviceId: 'dev-phone-01', name: 'Handy', linkedAt: 0 }] },
    });
    return { phone, desk, phoneT, deskT };
  };
  return { net, now, tick: (ms: number) => (clock += ms), make, pair, forge, twoDevices };
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

/** Texts that show up in a chat thread (everything when no thread is given). */
function chats(node: SocialNode, thread?: string): string[] {
  const out: string[] = [];
  node.on((e) => e.type === 'chat' && (thread === undefined || e.thread === thread) && e.entry.from !== 'me' && out.push(e.entry.text));
  return out;
}

/** Groups the app shows (and I can write in). */
const visibleGroups = (node: SocialNode) => node.getState().groups.filter((g) => !g.dissolved);

function rule(id: string, values: Record<string, string | number>): Rule {
  const r = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === id)!, values);
  if (!r.ok) throw new Error(r.errors.join(', '));
  return r.value;
}

const groupText = (groupId: string): MessageOf<'group.text'> => ({ v: 1, id: 'probe-text-01', sentAt: 0, type: 'group.text', groupId, text: 'hi' });

describe('groups: an owner who is no longer my contact', () => {
  async function maxsGroup() {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const eve = w.make(EVE, 'Eve');
    for (const n of [lisa, max, eve]) await n.start();
    await w.pair(lisa, max);
    await w.pair(max, eve); // Lisa does not know Eve; Max vouches for her in his group.
    const g = await max.createGroup('Familie', [LISA, EVE]);
    await flush();
    expect(visibleGroups(lisa)).toHaveLength(1);
    return { ...w, lisa, max, eve, g };
  }

  it('can no longer write to me, add people or let the people they added reach me: I leave their groups', async () => {
    const { lisa, max, eve, g, forge } = await maxsGroup();
    const got = chats(lisa);
    const maxAlerts = alerts(max);

    // Max harasses Lisa, so she removes him.
    await lisa.removeContact(MAX);
    await flush();
    expect(visibleGroups(lisa)).toEqual([]);
    expect(max.getState().groups[0]?.members.map((m) => m.name)).toEqual(['Max', 'Eve']);
    expect(maxAlerts.map((a) => a.body)).toEqual(['Lisa hat die Gruppe verlassen.']);

    await max.sendGroupText(g.id, 'du entkommst mir nicht');
    await eve.sendGroupText(g.id, 'Hier ist Mama, neue Nummer');
    // He adds her back, together with a stranger under a name Lisa trusts.
    await forge(MAX)(LISA, {
      type: 'group.update',
      groupId: g.id,
      name: 'Familie',
      owner: MAX,
      members: [
        { key: MAX, name: 'Max' },
        { key: LISA, name: 'Lisa' },
        { key: EVE, name: 'Eve' },
        { key: TOM, name: 'Mama' },
      ],
      version: 5,
    });
    expect(got).toEqual([]);
    expect(visibleGroups(lisa)).toEqual([]);
    // The transport keeps their messages out of its list of handled ones.
    expect(lisa.acceptsMessage(MAX, groupText(g.id))).toBe(false);
    expect(lisa.acceptsMessage(EVE, groupText(g.id))).toBe(false);
  });

  it('can add me again once we are connected again', async () => {
    const { lisa, max, g, pair } = await maxsGroup();
    await lisa.removeContact(MAX);
    await flush();
    await pair(lisa, max);
    await max.editGroup(g.id, { members: [EVE, LISA] });
    await flush();
    expect(visibleGroups(lisa).map((x) => x.members.map((m) => m.name))).toEqual([['Max', 'Eve', 'Lisa']]);
  });

  it('in a group of theirs I am still in (say from an older version), only lets me go', () => {
    const w = world();
    const group = {
      id: 'group-of-max-1',
      name: 'Familie',
      owner: MAX,
      members: [
        { key: MAX, name: 'Max' },
        { key: LISA, name: 'Lisa' },
        { key: EVE, name: 'Eve' },
      ],
      version: 3,
      updatedAt: 0,
    };
    const lisa = w.make(LISA, 'Lisa', { initial: { ...state(LISA, 'Lisa'), groups: [group] } });
    const roster = (members: { key: string; name: string }[], dissolved?: boolean): MessageOf<'group.update'> => ({
      v: 1,
      id: 'probe-roster-1',
      sentAt: 0,
      type: 'group.update',
      groupId: group.id,
      name: 'Familie',
      owner: MAX,
      members,
      version: 4,
      ...(dissolved ? { dissolved } : {}),
    });
    expect(lisa.acceptsMessage(EVE, groupText(group.id))).toBe(false);
    expect(lisa.acceptsMessage(MAX, groupText(group.id))).toBe(false);
    expect(lisa.acceptsMessage(MAX, roster([...group.members, { key: TOM, name: 'Mama' }]))).toBe(false);
    expect(lisa.acceptsMessage(MAX, roster([group.members[0]!, group.members[2]!]))).toBe(true);
    expect(lisa.acceptsMessage(MAX, roster(group.members, true))).toBe(true);
  });

  it('in a group I own, members who are no longer my contacts can still leave it', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const mia = w.make(MIA, 'Mia');
    for (const n of [lisa, max, mia]) await n.start();
    await w.pair(lisa, max);
    await w.pair(lisa, mia);
    const g = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    await lisa.removeContact(MAX);
    await flush();
    await max.leaveGroup(g.id);
    await flush();
    expect(lisa.getState().groups[0]?.members.map((m) => m.key)).toEqual([LISA, MIA]);
  });
});

describe('groups: removed and added back', () => {
  async function trio() {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const mia = w.make(MIA, 'Mia');
    for (const n of [lisa, max, mia]) await n.start();
    await w.pair(lisa, max);
    await w.pair(lisa, mia);
    return { ...w, lisa, max, mia };
  }

  it('someone the owner removed by mistake and added back is in the group again and gets its messages', async () => {
    const { lisa, max, tick } = await trio();
    const g = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    await lisa.editGroup(g.id, { members: [MIA] });
    await flush();
    expect(visibleGroups(max)).toEqual([]);
    tick(MIN);
    const got = alerts(max);
    await lisa.editGroup(g.id, { members: [MAX, MIA] });
    await flush();
    expect(visibleGroups(max).map((x) => x.members.map((m) => m.name))).toEqual([['Lisa', 'Max', 'Mia']]);
    expect(got.map((a) => a.body)).toEqual(['Lisa hat dich zur Gruppe hinzugefügt.']);
    const texts = chats(max, `g:${g.id}`);
    await lisa.sendGroupText(g.id, 'Essen ist fertig');
    await flush();
    expect(texts).toEqual(['Essen ist fertig']);
  });

  it('an older roster that arrives after the removal does not add them back', async () => {
    const { lisa, max, forge, now } = await trio();
    const g = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    const sentAt = now();
    await lisa.editGroup(g.id, { members: [MIA] });
    await flush();
    // Relays hand over stored messages in any order: version 1 still lists Max.
    await forge(LISA)(MAX, { type: 'group.update', groupId: g.id, name: 'Familie', owner: LISA, members: g.members, version: 1 }, sentAt);
    expect(visibleGroups(max)).toEqual([]);
  });

  it('on my other device too, and settings from a device that has not caught up do not undo it', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const mia = w.make(MIA, 'Mia');
    const { phone, desk, deskT } = w.twoDevices(MAX, 'Max');
    for (const n of [lisa, mia, phone, desk]) await n.start();
    await w.pair(phone, lisa);
    await w.pair(lisa, mia);
    await phone.flushSync();
    await flush();
    const g = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    await lisa.editGroup(g.id, { members: [MIA] });
    await flush();
    expect(visibleGroups(phone)).toEqual([]);
    expect(visibleGroups(desk)).toEqual([]);

    // The PC is off while Lisa adds Max back; it still sends what it knew before.
    await deskT.stop();
    await lisa.editGroup(g.id, { members: [MAX, MIA] });
    await flush();
    expect(visibleGroups(phone)).toHaveLength(1);
    desk.updateContact(LISA, { favorite: true });
    await desk.flushSync();
    await flush();
    expect(visibleGroups(phone)).toHaveLength(1);

    await deskT.start();
    await flush();
    await phone.flushSync();
    await flush();
    expect(visibleGroups(desk)).toHaveLength(1);
    expect(visibleGroups(phone)).toHaveLength(1);
  });

  it('someone who left on their own stays out, and the owner sees that again instead of a member who gets nothing', async () => {
    const { lisa, max, tick } = await trio();
    const g = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    await max.leaveGroup(g.id);
    await flush();
    tick(MIN);
    const got = alerts(lisa);
    await lisa.editGroup(g.id, { members: [MAX, MIA] });
    await flush();
    expect(visibleGroups(max)).toEqual([]);
    expect(lisa.getState().groups[0]?.members.map((m) => m.name)).toEqual(['Lisa', 'Mia']);
    expect(got.map((a) => a.body)).toEqual(['Max hat die Gruppe verlassen.']);
  });

  it('forgets the hidden copy after half a year, like a group I left', async () => {
    const { lisa, max, tick } = await trio();
    const g = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    await lisa.editGroup(g.id, { members: [MIA] });
    await flush();
    expect(max.getState().groups.map((x) => x.dissolved)).toEqual([true]);
    tick(181 * 24 * HOUR);
    await max.tick();
    expect(max.getState().groups).toEqual([]);
  });

  it('hidden copies give way first when the list is full', () => {
    const group = (id: string, updatedAt: number, dissolved?: boolean) => ({ id, name: id, owner: LISA, members: [], version: 1, updatedAt, ...(dissolved ? { dissolved } : {}) });
    const list = [group('live-old-1', 0), group('gone-new-1', 5, true), group('live-new-1', 9), group('gone-old-1', 1, true)];
    expect(capGroups(list, 4)).toBe(list);
    expect(capGroups(list, 3).map((g) => g.id)).toEqual(['live-old-1', 'gone-new-1', 'live-new-1']);
    expect(capGroups(list, 2).map((g) => g.id)).toEqual(['live-old-1', 'live-new-1']);
  });
});

describe('groups: what a removed member learns', () => {
  it('only that they are out: not who was added in the same change, nor the new name', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const mia = w.make(MIA, 'Mia');
    const tom = w.make(TOM, 'Tom');
    for (const n of [lisa, max, mia, tom]) await n.start();
    await w.pair(lisa, max);
    await w.pair(lisa, mia);
    await w.pair(lisa, tom);
    const g = await lisa.createGroup('Familie', [MAX, MIA]);
    await flush();
    const got = alerts(mia);
    const before = w.net.log.length;
    await lisa.editGroup(g.id, { name: 'Familie (neu)', members: [MAX, TOM] });
    await flush();

    const toMia = w.net.log.slice(before).filter((e) => e.to === MIA && e.message.type === 'group.update');
    expect(toMia).toHaveLength(1);
    const roster = toMia[0]!.message as MessageOf<'group.update'>;
    expect(roster.members.map((m) => m.key)).toEqual([LISA]);
    expect(roster.name).toBe('Familie');
    expect(visibleGroups(mia)).toEqual([]);
    expect(got.map((a) => `${a.title}: ${a.body}`)).toEqual(['Familie: Du bist nicht mehr in dieser Gruppe.']);
    // The others get the whole new roster.
    expect(visibleGroups(tom)[0]?.members.map((m) => m.name)).toEqual(['Lisa', 'Max', 'Tom']);
    expect(visibleGroups(max)[0]?.name).toBe('Familie (neu)');
  });
});

describe('check-ins sent by an automation', () => {
  async function three() {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const mia = w.make(MIA, 'Mia');
    for (const n of [lisa, max, mia]) await n.start();
    await w.pair(lisa, max);
    await w.pair(lisa, mia);
    return { ...w, lisa, max, mia };
  }

  it('never end my watches when a contact set them off', async () => {
    const { lisa, max, mia, now } = await three();
    lisa.setRules([
      {
        id: 'rule-reply-ok-1',
        name: 'Antwort',
        enabled: true,
        trigger: { on: 'contact.message', contact: MAX, contains: 'alles gut?' },
        conditions: [],
        actions: [{ do: 'send_checkin', to: [MAX], kind: 'ok' }],
        source: 'blocks',
      },
    ]);
    // Lisa walks home alone at night: Mia gets an alarm if she does not check in.
    await lisa.startWatch({ to: [MIA], label: 'Heimweg', dueAt: now() + HOUR });
    await flush();
    const miaEvents = events(mia);
    const fromLisa = chats(max, LISA);
    // Max (or whoever has his phone) writes the words that set the rule off.
    await max.sendChat(LISA, 'Alles gut?');
    await flush();
    expect(fromLisa).toEqual(['👍 Alles okay']);
    expect(lisa.getState().watches.map((x) => x.label)).toEqual(['Heimweg']);
    expect(miaEvents.filter((e) => e.type === 'alarm.cancel' || e.type === 'alert')).toEqual([]);
    expect(mia.getStatus(LISA).watches?.map((x) => x.label)).toEqual(['Heimweg']);
  });

  it('when I arrive at my place, end only the watches whose people all got the check-in', async () => {
    const { lisa, mia, now } = await three();
    lisa.setPlaces([{ id: 'home', name: 'Zuhause', center: home, radiusM: 100 }]);
    lisa.setRules([rule('core.home-safe', { myplace: 'home', contact: MIA })]);
    await lisa.startWatch({ to: [MIA], label: 'Heimweg', dueAt: now() + HOUR });
    await lisa.startWatch({ to: [MIA, MAX], label: 'Wanderung', dueAt: now() + 2 * HOUR });
    await flush();
    const miaAlerts = alerts(mia);
    await lisa.onPlaceTransition('home', 'arrive');
    await flush();
    expect(lisa.getState().watches.map((x) => x.label)).toEqual(['Wanderung']);
    expect(miaAlerts.map((a) => a.body)).toContain('✅ hat sich gemeldet („Heimweg“)');
    expect(mia.getStatus(LISA).watches?.map((x) => x.label)).toEqual(['Wanderung']);
  });
});

describe('check-ins from another of my devices', () => {
  async function setup() {
    const w = world();
    const max = w.make(MAX, 'Max');
    const lisa = w.twoDevices(LISA, 'Lisa');
    for (const n of [max, lisa.phone, lisa.desk]) await n.start();
    await w.pair(lisa.phone, max);
    await lisa.phone.flushSync();
    await flush();
    expect(lisa.desk.getState().contacts.map((c) => c.key)).toEqual([MAX]);
    return { ...w, ...lisa, max };
  }

  it('"Alles okay" on the PC ends the watch the phone started, for the watchers and on the phone', async () => {
    const { phone, desk, max, tick, now } = await setup();
    const phoneEvents = events(phone);
    const deskEvents = events(desk);
    const watchId = await phone.startWatch({ to: [MAX], label: 'Heimweg', dueAt: now() + 30 * MIN });
    await flush();
    // The PC knows it, and reminds me too.
    expect(desk.getState().watches.map((x) => x.watchId)).toEqual([watchId]);
    expect(deskEvents.some((e) => e.type === 'alarm.schedule' && e.alarm.id === `mywatch:${watchId}:due`)).toBe(true);
    const maxEvents = events(max);
    const maxAlerts = alerts(max);

    tick(10 * MIN);
    await desk.sendCheckin({ to: [MAX], kind: 'ok' });
    await flush();
    expect(maxEvents.some((e) => e.type === 'alarm.cancel' && e.id === `watch:${LISA}:${watchId}`)).toBe(true);
    expect(maxAlerts.map((a) => a.body)).toContain('✅ hat sich gemeldet („Heimweg“)');
    expect(phone.getState().watches).toEqual([]);
    expect(desk.getState().watches).toEqual([]);
    expect(phoneEvents.some((e) => e.type === 'alarm.cancel' && e.id === `mywatch:${watchId}:due`)).toBe(true);

    tick(25 * MIN);
    await max.tick();
    expect(maxAlerts.filter((a) => a.category === 'watch')).toEqual([]);
  });

  it('a watch started on the PC ends from the phone, even when the PC is off by then', async () => {
    const { phone, desk, deskT, max, tick, now } = await setup();
    await desk.startWatch({ to: [MAX], label: 'Heimweg', dueAt: now() + 30 * MIN });
    await flush();
    await deskT.stop();
    const maxAlerts = alerts(max);
    tick(10 * MIN);
    await phone.sendCheckin({ to: [MAX], kind: 'arrived' });
    await flush();
    expect(max.getStatus(LISA).watches ?? []).toEqual([]);
    tick(25 * MIN);
    await max.tick();
    expect(maxAlerts.filter((a) => a.category === 'watch')).toEqual([]);
  });

  it('a late copy of a watch that ended does not bring it back', async () => {
    const { phone, desk, max, now, forge } = await setup();
    const startedAt = now();
    const watchId = await phone.startWatch({ to: [MAX], label: 'Heimweg', dueAt: now() + 30 * MIN });
    await flush();
    await phone.endWatch(watchId, 'ok');
    await flush();
    expect(desk.getState().watches).toEqual([]);
    // Relays may still hand over the phone's first announcement, from the same account.
    const body = { type: 'sync.watch', deviceId: 'dev-phone-01', watchId, recipients: [MAX], label: 'Heimweg', dueAt: startedAt + 30 * MIN, startedAt };
    await forge(LISA)(LISA, body as AppMessageBody, startedAt);
    expect(desk.getState().watches).toEqual([]);
    expect(max.getStatus(LISA).watches ?? []).toEqual([]);
  });

  it('a moved deadline reaches the other device, and an older copy does not move it back', async () => {
    const { phone, desk, now, tick, forge } = await setup();
    const startedAt = now();
    const watchId = await phone.startWatch({ to: [MAX], label: 'Heimweg', dueAt: startedAt + 30 * MIN });
    await flush();
    tick(MIN);
    const dueAt = now() + 2 * HOUR;
    await phone.extendWatch(watchId, dueAt);
    await flush();
    expect(desk.getState().watches.map((x) => x.dueAt)).toEqual([dueAt]);
    const body = { type: 'sync.watch', deviceId: 'dev-phone-01', watchId, recipients: [MAX], label: 'Heimweg', dueAt: startedAt + 30 * MIN, startedAt };
    await forge(LISA)(LISA, body as AppMessageBody, startedAt);
    expect(desk.getState().watches.map((x) => x.dueAt)).toEqual([dueAt]);
  });
});

describe('check-ins and the place I am at', () => {
  it('add the place only when everyone it goes to may see that place', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const mia = w.make(MIA, 'Mia');
    for (const n of [lisa, max, mia]) await n.start();
    await w.pair(lisa, max);
    await w.pair(lisa, mia);
    lisa.setPlaces([{ id: 'doc', name: 'Frauenarzt Dr. Weber', center: home, radiusM: 100 }]);
    lisa.syncPlaceState('doc', true);
    expect(lisa.currentPlace()?.name).toBe('Frauenarzt Dr. Weber');

    // Nobody may see this place.
    expect(lisa.checkinPlace([MAX])).toBeUndefined();
    await lisa.sendCheckin({ to: [MAX], kind: 'ok' });
    await flush();
    expect(max.getStatus(LISA).lastCheckin?.placeName).toBeUndefined();

    // Max may, Mia may not: a check-in to both leaves it out.
    lisa.setGrants([{ contactKey: MAX, placeIds: ['doc'] }]);
    expect(lisa.checkinPlace([MAX])).toBe('Frauenarzt Dr. Weber');
    expect(lisa.checkinPlace([MAX, MIA])).toBeUndefined();
    await lisa.sendCheckin({ to: [MAX, MIA], kind: 'ok' });
    await flush();
    expect(mia.getStatus(LISA).lastCheckin?.placeName).toBeUndefined();
    expect(max.getStatus(LISA).lastCheckin?.placeName).toBeUndefined();

    await lisa.sendCheckin({ to: [MAX], kind: 'ok' });
    await flush();
    expect(max.getStatus(LISA).lastCheckin?.placeName).toBe('Frauenarzt Dr. Weber');

    // Switched off on the screen.
    await lisa.sendCheckin({ to: [MAX], kind: 'home', autoPlace: false });
    await flush();
    expect(max.getStatus(LISA).lastCheckin).toMatchObject({ kind: 'home' });
    expect(max.getStatus(LISA).lastCheckin?.placeName).toBeUndefined();

    // In ghost mode never.
    await lisa.setGhost(true);
    expect(lisa.checkinPlace([MAX])).toBeUndefined();
  });
});
