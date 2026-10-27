import { describe, expect, it } from 'vitest';
import { SocialNode } from './node';
import { parseAppMessage, type AppMessage, type AppMessageBody, type MessageOf } from './protocol/messages';
import { createInitialState, type Alert, type Contact, type NodeState } from './state';
import { MemoryNetwork, type MemoryTransport } from './transport/memory';

/**
 * Regression tests for messages that arrive before what they depend on (relays hand stored
 * messages over in any order): they must wait, not get lost. And for an older trip's end that
 * arrives while a newer trip runs. Each one first reproduced the problem before it was fixed.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const MIA = '4'.repeat(64);
const RELAY = ['wss://relay.example'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon, accuracyM: 10 });

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

const contact = (key: string, name: string): Contact => ({ key, name, relays: RELAY, addedAt: 0, verified: true });

function state(key: string, name: string, contacts: Contact[] = [], extra: Partial<NodeState> = {}): NodeState {
  return { ...createInitialState({ key, name, relays: RELAY, deviceId: `dev-${name}-00`, deviceName: `${name}s Handy` }), contacts, ...extra };
}

/**
 * Like the relay transport: what the node's `acceptsMessage` turns down is not marked as handled
 * but held, and offered again by `redeliverRefused()`. Without that contract nothing could wait.
 */
function holdingTransport(net: MemoryNetwork, key: string, now: () => number) {
  const t = net.createTransport(key, now) as MemoryTransport & { redeliverRefused(): void };
  const held: { from: string; raw: string }[] = [];
  let accept: (from: string, m: AppMessage) => boolean = () => true;
  const receive = t.receive.bind(t);
  t.receive = (from: string, raw: string) => {
    const parsed = parseAppMessage(raw);
    if (parsed.ok && !accept(from, parsed.message)) {
      held.push({ from, raw });
      return;
    }
    receive(from, raw);
  };
  t.redeliverRefused = () => {
    for (const h of held.splice(0)) t.receive(h.from, h.raw);
  };
  return Object.assign(t, { held, setAccept: (a: typeof accept) => (accept = a) });
}

function world() {
  let clock = 12 * HOUR;
  const now = () => clock;
  const net = new MemoryNetwork();
  /** Max's phone, whose transport holds what his node turns down. */
  const maxWith = (initial: NodeState) => {
    const t = holdingTransport(net, MAX, now);
    const node = new SocialNode({ transport: t, initialState: initial, now, localTime, syncDelayMs: 0 });
    t.setAccept((from, m) => node.acceptsMessage(from, m));
    return { node, t };
  };
  /** Sends a hand-made message as `from`, with the sender's clock at `sentAt`. Ids stay unique per sender. */
  const counters = new Map<string, number>();
  const forge = (from: string) => {
    const t = net.createTransport(from, now);
    return async (to: string, body: AppMessageBody, sentAt = clock) => {
      const n = counters.get(from) ?? 0;
      counters.set(from, n + 1);
      await t.send(to, { ...body, v: 1, id: `forged-${from.slice(0, 4)}-${String(n).padStart(6, '0')}`, sentAt } as AppMessage);
      await flush();
    };
  };
  return { net, now, tick: (ms: number) => (clock += ms), maxWith, forge };
}

function alerts(node: SocialNode): Alert[] {
  const out: Alert[] = [];
  node.on((e) => e.type === 'alert' && out.push(e.alert));
  return out;
}

function chats(node: SocialNode): string[] {
  const out: string[] = [];
  node.on((e) => e.type === 'chat' && e.entry.from !== 'me' && out.push(`${e.thread}: ${e.entry.text}`));
  return out;
}

const visibleGroups = (node: SocialNode) => node.getState().groups.filter((g) => !g.dissolved);

const GROUP = 'grp-familie-01';
const roster = (version: number, members: string[], extra: Partial<MessageOf<'group.update'>> = {}): AppMessageBody => ({
  type: 'group.update',
  groupId: GROUP,
  name: 'Familie',
  owner: LISA,
  members: members.map((key) => ({ key, name: key === LISA ? 'Lisa' : key === MAX ? 'Max' : 'Mia' })),
  version,
  ...extra,
});

describe('messages that arrive before what they depend on', () => {
  it('a group message from a contact that comes before the roster waits for it, and then shows once', async () => {
    const w = world();
    const { node: max, t } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa'), contact(MIA, 'Mia')]));
    await max.start();
    const got = chats(max);
    await w.forge(MIA)(MAX, { type: 'group.text', groupId: GROUP, text: 'Hallo Familie' });
    expect(t.held).toHaveLength(1);
    await w.forge(LISA)(MAX, roster(1, [LISA, MAX, MIA]));
    await flush();
    expect(visibleGroups(max).map((g) => g.name)).toEqual(['Familie']);
    expect(got).toEqual([`g:${GROUP}: Hallo Familie`]);
    expect(t.held).toEqual([]);
  });

  it('a group message from a contact the roster does not list yet waits for the roster that adds them', async () => {
    const w = world();
    const { node: max } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa'), contact(MIA, 'Mia')]));
    await max.start();
    const got = chats(max);
    await w.forge(LISA)(MAX, roster(1, [LISA, MAX]));
    await w.forge(MIA)(MAX, { type: 'group.text', groupId: GROUP, text: 'Bin jetzt auch da' });
    await w.forge(LISA)(MAX, roster(2, [LISA, MAX, MIA]));
    await flush();
    expect(got).toEqual([`g:${GROUP}: Bin jetzt auch da`]);
  });

  it('a group message for a group I left is not kept waiting', () => {
    const w = world();
    const { node: max } = w.maxWith(state(MAX, 'Max', [contact(MIA, 'Mia')], { leftGroups: [{ id: GROUP, at: w.now() }] }));
    const text: MessageOf<'group.text'> = { v: 1, id: 'probe-text-01', sentAt: 0, type: 'group.text', groupId: GROUP, text: 'hi' };
    expect(max.acceptsMessage(MIA, text)).toBe(true);
  });

  it('a roster that takes me off, caught up before the one that added me, keeps me out', async () => {
    const w = world();
    const { node: max } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa')]));
    await max.start();
    const got = alerts(max);
    // What Lisa sends someone she takes off: the owner alone.
    await w.forge(LISA)(MAX, roster(2, [LISA]), w.now());
    await w.forge(LISA)(MAX, roster(1, [LISA, MAX, MIA]), w.now() - MIN);
    expect(visibleGroups(max)).toEqual([]);
    expect(got.filter((a) => a.category === 'group')).toEqual([]);
    // She can still add me back later.
    await w.forge(LISA)(MAX, roster(3, [LISA, MAX]));
    expect(visibleGroups(max).map((g) => g.version)).toEqual([3]);
  });

  it('a dissolved group, caught up before the roster that added me, does not come back', async () => {
    const w = world();
    const { node: max } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa')]));
    await max.start();
    await w.forge(LISA)(MAX, roster(2, [LISA, MAX], { dissolved: true }), w.now());
    await w.forge(LISA)(MAX, roster(1, [LISA, MAX]), w.now() - MIN);
    expect(visibleGroups(max)).toEqual([]);
  });

  it('someone leaving a group this device does not know yet waits for it; members who only get told take it at once', () => {
    const w = world();
    const owned = { id: GROUP, name: 'Familie', owner: LISA, members: [{ key: LISA, name: 'Lisa' }, { key: MAX, name: 'Max' }], version: 1, updatedAt: 0 };
    const leave: MessageOf<'group.leave'> = { v: 1, id: 'probe-leave-01', sentAt: 0, type: 'group.leave', groupId: GROUP };
    // Lisa's PC, before her phone's sync brings the group she owns.
    const pc = new SocialNode({ transport: w.net.createTransport(LISA, w.now), initialState: state(LISA, 'Lisa', [contact(MAX, 'Max')]), now: w.now });
    expect(pc.acceptsMessage(MAX, leave)).toBe(false);
    const pcLater = new SocialNode({ transport: w.net.createTransport(LISA, w.now), initialState: state(LISA, 'Lisa', [contact(MAX, 'Max')], { groups: [owned] }), now: w.now });
    expect(pcLater.acceptsMessage(MAX, leave)).toBe(true);
    // Mia is in Lisa's group too: she is told, but only the owner acts on it.
    const mia = new SocialNode({
      transport: w.net.createTransport(MIA, w.now),
      initialState: state(MIA, 'Mia', [contact(MAX, 'Max')], { groups: [{ ...owned, members: [...owned.members, { key: MIA, name: 'Mia' }] }] }),
      now: w.now,
    });
    expect(mia.acceptsMessage(MAX, leave)).toBe(true);
  });

  it('a newer SOS location caught up before the SOS itself is not lost', async () => {
    const w = world();
    const { node: max } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa')]));
    await max.start();
    const got = alerts(max);
    const t0 = w.now() - 30 * MIN;
    await w.forge(LISA)(MAX, { type: 'sos.update', sosId: 'sos-lisa-0001', point: north(900) }, t0 + 20 * MIN);
    await w.forge(LISA)(MAX, { type: 'sos.start', sosId: 'sos-lisa-0001', text: 'Hilfe', point: north(100), others: [] }, t0);
    await flush();
    expect(max.getStatus(LISA).sos?.point?.lat).toBeCloseTo(north(900).lat, 6);
    expect(got.filter((a) => a.category === 'sos').map((a) => a.level)).toEqual(['alarm']);
  });

  it('a helper saying "Ich kümmere mich" before the SOS itself arrived still shows', async () => {
    const w = world();
    const { node: max } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa'), contact(MIA, 'Mia')]));
    await max.start();
    const t0 = w.now() - 10 * MIN;
    await w.forge(MIA)(MAX, { type: 'sos.ack', sosId: 'sos-lisa-0002', owner: LISA, text: 'Bin unterwegs' }, t0 + 5 * MIN);
    await w.forge(LISA)(MAX, { type: 'sos.start', sosId: 'sos-lisa-0002', text: 'Hilfe', others: [{ key: MIA, name: 'Mia' }] }, t0);
    await flush();
    expect(max.getStatus(LISA).sos?.acks.map((a) => [a.key, a.text])).toEqual([[MIA, 'Bin unterwegs']]);
  });

  it('a late update of an SOS that was replaced by a newer one is not kept waiting', async () => {
    const w = world();
    const { node: max, t } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa')]));
    await max.start();
    await w.forge(LISA)(MAX, { type: 'sos.start', sosId: 'sos-lisa-new1', text: 'Hilfe', others: [] }, w.now());
    await w.forge(LISA)(MAX, { type: 'sos.update', sosId: 'sos-lisa-old1', point: north(300) }, w.now() - HOUR);
    expect(t.held).toEqual([]);
  });
});

describe('the end of an older trip', () => {
  it('does not say they arrived while a newer trip of theirs runs', async () => {
    const w = world();
    const { node: max } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa')]));
    max.setRules([
      {
        id: 'arrived-rule-1',
        name: 'Angekommen',
        enabled: true,
        trigger: { on: 'contact.trip_end', contact: LISA, reason: 'arrived' },
        conditions: [],
        actions: [{ do: 'notify', title: 'Lisa ist da', body: 'Gut angekommen' }],
        source: 'manual',
      },
    ]);
    await max.start();
    const got = alerts(max);
    const base = w.now() - HOUR;
    await w.forge(LISA)(MAX, { type: 'session.start', sessionId: 'trip-new-0001', level: 'eta', destinationName: 'Kino', expiresAt: w.now() + HOUR }, base + 30 * MIN);
    // The end of her earlier trip, held up on the relays.
    await w.forge(LISA)(MAX, { type: 'session.end', sessionId: 'trip-old-0001', reason: 'arrived' }, base + 10 * MIN);
    expect(max.getStatus(LISA).trip?.sessionId).toBe('trip-new-0001');
    expect(got.map((a) => a.title)).toEqual(['Lisa ist unterwegs']);
    // Her current trip still ends as it should.
    await w.forge(LISA)(MAX, { type: 'session.end', sessionId: 'trip-new-0001', reason: 'arrived' }, w.now());
    expect(got.map((a) => a.title)).toEqual(['Lisa ist unterwegs', 'Lisa ist angekommen', 'Lisa ist da']);
  });

  it('still says they arrived when the end comes before its start, or after the trip I knew of', async () => {
    const w = world();
    const { node: max } = w.maxWith(state(MAX, 'Max', [contact(LISA, 'Lisa')]));
    await max.start();
    const got = alerts(max);
    const base = w.now() - HOUR;
    await w.forge(LISA)(MAX, { type: 'session.end', sessionId: 'trip-a-000001', reason: 'arrived' }, base + 20 * MIN);
    expect(got.map((a) => [a.title, a.body])).toEqual([['Lisa ist angekommen', '📍 am Ziel']]);
    // An older trip shown here, and the end of a newer one whose start was lost.
    await w.forge(LISA)(MAX, { type: 'session.start', sessionId: 'trip-b-000001', level: 'eta', destinationName: 'Arbeit', expiresAt: w.now() + HOUR }, base + 30 * MIN);
    await w.forge(LISA)(MAX, { type: 'session.end', sessionId: 'trip-c-000001', reason: 'arrived' }, base + 50 * MIN);
    expect(got.filter((a) => a.title === 'Lisa ist angekommen')).toHaveLength(2);
  });
});
