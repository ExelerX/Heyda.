import { describe, expect, it, vi } from 'vitest';
import type { Rule } from './automation/schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './automation/templates';
import { SocialNode } from './node';
import { createInitialState, normalizeState, type Alert, type DeviceKind, type LinkedDevice, type NodeState } from './state';
import { buildSyncDoc, parseSyncDoc } from './sync/doc';
import { createLinkedState } from './sync/receiver';
import { MemoryNetwork, type MemoryTransport } from './transport/memory';

/**
 * Automations on an account with more than one device (phone and Windows app), and names in
 * what automations send. Each test first reproduced the problem before it was fixed.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const OMA = '4'.repeat(64);
const RELAY = ['wss://relay.example'];
const HOUR = 3600_000;

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function state(key: string, name: string, deviceId = `dev-${name}-00`, devices: LinkedDevice[] = []): NodeState {
  return { ...createInitialState({ key, name, relays: RELAY, deviceId, deviceName: `${name}s Gerät` }), devices };
}

function world() {
  let clock = 12 * HOUR;
  const now = () => clock;
  const net = new MemoryNetwork();
  const make = (key: string, name: string, opts: { initial?: NodeState; deviceKind?: DeviceKind; transport?: MemoryTransport } = {}) =>
    new SocialNode({
      transport: opts.transport ?? net.createTransport(key, now),
      initialState: opts.initial ?? state(key, name),
      now,
      localTime: (t) => ({ minutes: Math.floor(t / 60_000) % 1440, weekday: 3 }),
      syncDelayMs: 0,
      deviceKind: opts.deviceKind,
    });
  const pair = async (a: SocialNode, b: SocialNode) => {
    await a.acceptInvite(b.createInvite());
    await flush();
  };
  return { net, now, tick: (ms: number) => (clock += ms), make, pair };
}

function rule(id: string, values: Record<string, string | number>): Rule {
  const r = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === id)!, values);
  if (!r.ok) throw new Error(r.errors.join(', '));
  return r.value;
}

function alerts(node: SocialNode): Alert[] {
  const out: Alert[] = [];
  node.on((e) => e.type === 'alert' && out.push(e.alert));
  return out;
}

function chats(node: SocialNode): string[] {
  const out: string[] = [];
  node.on((e) => e.type === 'chat' && e.entry.from !== 'me' && out.push(e.entry.text));
  return out;
}

/** Lisa on her phone and on the Windows app, both with the same rules, and Max as her contact. */
async function lisaOnTwoDevices(rules: (r: typeof rule) => Rule[], pcDevices?: LinkedDevice[], phoneDevices?: LinkedDevice[]) {
  const w = world();
  const max = w.make(MAX, 'Max');
  const phone = w.make(LISA, 'Lisa', { initial: state(LISA, 'Lisa', 'dev-phone-01', phoneDevices ?? [{ deviceId: 'dev-desk-001', name: 'PC', linkedAt: 0 }]) });
  await max.start();
  await phone.start();
  await w.pair(phone, max);
  phone.setRules(rules(rule));
  const copy = JSON.parse(JSON.stringify(phone.getState())) as NodeState;
  const pc = w.make(LISA, 'Lisa', {
    deviceKind: 'computer',
    initial: {
      ...copy,
      self: { ...copy.self, deviceId: 'dev-desk-001', deviceName: 'PC' },
      devices: pcDevices ?? [{ deviceId: 'dev-phone-01', name: 'Handy', linkedAt: 0 }],
    },
  });
  await pc.start();
  return { ...w, max, phone, pc };
}

describe('automations on more than one device', () => {
  it('what reaches other people goes out once, from the phone; notifications show on both', async () => {
    const { max, phone, pc } = await lisaOnTwoDevices((r) => [
      r('core.checkin-heart', { contact: MAX }),
      r('core.pickup-alert', { contact: MAX }),
    ]);
    const got = chats(max);
    await max.sendCheckin({ to: [LISA], kind: 'arrived' });
    await flush();
    expect(got.filter((t) => t.includes('Denk an dich'))).toHaveLength(1);

    const phoneAlerts = alerts(phone);
    const pcAlerts = alerts(pc);
    await max.sendPing(LISA, 'pickup-request');
    await flush();
    expect(phoneAlerts.filter((a) => a.category === 'automation').map((a) => a.title)).toEqual(['Max möchte abgeholt werden']);
    expect(pcAlerts.filter((a) => a.category === 'automation').map((a) => a.title)).toEqual(['Max möchte abgeholt werden']);
    expect(pc.runsAutomationActions).toBe(false);
    expect(phone.runsAutomationActions).toBe(true);
  });

  it('a contact cannot make the Windows app start a trip of its own', async () => {
    const tripOnPing: Rule = {
      id: 'trip-on-ping-1',
      name: 'Abholen',
      enabled: true,
      trigger: { on: 'contact.ping', contact: MAX, kind: 'pickup-request' },
      conditions: [],
      actions: [{ do: 'start_trip', to: [MAX], destination: 'home', level: 'eta' }],
      source: 'manual',
    };
    const { max, phone, pc } = await lisaOnTwoDevices(() => [tripOnPing]);
    // The same place on both devices, as the settings sync brings it.
    const home = { id: 'home', name: 'Zuhause', center: { lat: 52.52, lon: 13.405 }, radiusM: 100 };
    phone.setPlaces([home]);
    pc.setPlaces([home]);
    await max.sendPing(LISA, 'pickup-request');
    await flush();
    expect(phone.activeTrip).toBeDefined();
    expect(pc.activeTrip).toBeUndefined();
  });

  it('the Windows app does not start a trip without GPS, and notes that in the activity list', async () => {
    const w = world();
    const max = w.make(MAX, 'Max');
    const pc = w.make(LISA, 'Lisa', { deviceKind: 'computer' });
    await max.start();
    await pc.start();
    await w.pair(pc, max);
    pc.setPlaces([{ id: 'home', name: 'Zuhause', center: { lat: 52.52, lon: 13.405 }, radiusM: 100 }]);
    pc.setRules([
      {
        id: 'trip-on-ping-2',
        name: 'Abholen',
        enabled: true,
        trigger: { on: 'contact.ping', contact: MAX, kind: 'pickup-request' },
        conditions: [],
        actions: [{ do: 'start_trip', to: [MAX], destination: 'home', level: 'eta' }],
        source: 'manual',
      },
    ]);
    expect(pc.runsAutomationActions).toBe(true);
    const got = alerts(pc);
    await max.sendPing(LISA, 'pickup-request');
    await flush();
    expect(pc.activeTrip).toBeUndefined();
    expect(max.getStatus(LISA).trip).toBeUndefined();
    expect(w.net.log.filter((l) => l.from === LISA && l.message.type.startsWith('session.'))).toEqual([]);
    const note = got.filter((a) => a.category === 'automation');
    expect(note.map((a) => [a.title, a.level])).toEqual([['Ankunftszeit nicht geteilt', 'feed']]);
    expect(note[0]!.body).toContain('Zuhause');
  });

  it('the Windows app does it all when the account has no phone', async () => {
    const w = world();
    const max = w.make(MAX, 'Max');
    const pc = w.make(LISA, 'Lisa', { deviceKind: 'computer' });
    await max.start();
    await pc.start();
    await w.pair(pc, max);
    pc.setRules([rule('core.checkin-heart', { contact: MAX })]);
    expect(pc.runsAutomationActions).toBe(true);
    const got = chats(max);
    await max.sendCheckin({ to: [LISA], kind: 'arrived' });
    await flush();
    expect(got.filter((t) => t.includes('Denk an dich'))).toHaveLength(1);
  });

  it('learns from my other device whether it is a phone or a computer', async () => {
    const w = world();
    const deskA = w.make(LISA, 'Lisa', { deviceKind: 'computer', initial: state(LISA, 'Lisa', 'dev-desk-00A', [{ deviceId: 'dev-desk-00B', name: 'PC 2', linkedAt: 0 }]) });
    const deskB = w.make(LISA, 'Lisa', { deviceKind: 'computer', initial: state(LISA, 'Lisa', 'dev-desk-00B', [{ deviceId: 'dev-desk-00A', name: 'PC 1', linkedAt: 0 }]) });
    await deskA.start();
    await deskB.start();
    // Not known yet: it might be the phone, so neither sends anything for automations.
    expect(deskA.runsAutomationActions).toBe(false);
    deskB.setPrefs({ ...deskB.getState().prefs, off: [] });
    await deskB.flushSync();
    await flush();
    expect(deskA.getState().devices.find((d) => d.deviceId === 'dev-desk-00B')?.kind).toBe('computer');
    expect(deskA.runsAutomationActions).toBe(true);
  });

  it('a computer says what it is when it starts, the phone answers once, and then both stop', async () => {
    const w = world();
    const phoneTransport = w.net.createTransport(LISA, w.now);
    const phone = w.make(LISA, 'Lisa', { transport: phoneTransport, initial: state(LISA, 'Lisa', 'dev-phone-01', [{ deviceId: 'dev-desk-001', name: 'PC', linkedAt: 0 }]) });
    const pc = w.make(LISA, 'Lisa', { deviceKind: 'computer', initial: state(LISA, 'Lisa', 'dev-desk-001', [{ deviceId: 'dev-phone-01', name: 'Handy', linkedAt: 0 }]) });
    await phone.start();
    await pc.start();
    // Nothing changed in the settings: the computer still tells the phone what it is.
    await pc.flushSync();
    await flush();
    expect(phone.getState().devices[0]?.kind).toBe('computer');
    // The phone heard it for the first time and answers with what it is.
    await phone.flushSync();
    await flush();
    expect(pc.getState().devices[0]?.kind).toBe('phone');
    expect(pc.runsAutomationActions).toBe(false);
    // Both know each other now: no more back and forth.
    await pc.flushSync();
    await flush();
    const sent = vi.spyOn(phoneTransport, 'send');
    await phone.flushSync();
    await pc.flushSync();
    await flush();
    expect(sent).not.toHaveBeenCalled();
  });

  it('every phone keeps acting, so a phone left in a drawer never swallows what the other one should send', async () => {
    const w = world();
    const max = w.make(MAX, 'Max');
    const phone = w.make(LISA, 'Lisa', { initial: state(LISA, 'Lisa', 'dev-phone-02', [{ deviceId: 'dev-phone-01', name: 'Altes Handy', linkedAt: 0, kind: 'phone' }]) });
    await max.start();
    await phone.start();
    await w.pair(phone, max);
    phone.setRules([rule('core.checkin-heart', { contact: MAX })]);
    expect(phone.runsAutomationActions).toBe(true);
    const got = chats(max);
    await max.sendCheckin({ to: [LISA], kind: 'arrived' });
    await flush();
    expect(got.filter((t) => t.includes('Denk an dich'))).toHaveLength(1);
  });
});

describe('"Automationen senden von": the device I choose', () => {
  it('is the only one that sends, on every device once the choice synced: here the Windows app', async () => {
    const { max, phone, pc } = await lisaOnTwoDevices((r) => [r('core.checkin-heart', { contact: MAX })]);
    expect(phone.automationDevice).toBeUndefined();
    phone.setAutomationDevice('dev-desk-001');
    await phone.flushSync();
    await flush();
    expect(pc.getState().automationDevice).toBe('dev-desk-001');
    expect(pc.automationDevice).toBe('dev-desk-001');
    expect(pc.runsAutomationActions).toBe(true);
    expect(phone.runsAutomationActions).toBe(false);
    const got = chats(max);
    await max.sendCheckin({ to: [LISA], kind: 'arrived' });
    await flush();
    expect(got.filter((t) => t.includes('Denk an dich'))).toHaveLength(1);
  });

  it('with two phones, only the chosen one sends', async () => {
    const w = world();
    const max = w.make(MAX, 'Max');
    const a = w.make(LISA, 'Lisa', { initial: state(LISA, 'Lisa', 'dev-phone-0A', [{ deviceId: 'dev-phone-0B', name: 'Altes Handy', linkedAt: 0, kind: 'phone' }]) });
    await max.start();
    await a.start();
    await w.pair(a, max);
    a.setRules([rule('core.checkin-heart', { contact: MAX })]);
    a.setAutomationDevice('dev-phone-0A');
    const copy = JSON.parse(JSON.stringify(a.getState())) as NodeState;
    const b = w.make(LISA, 'Lisa', {
      initial: { ...copy, self: { ...copy.self, deviceId: 'dev-phone-0B', deviceName: 'Altes Handy' }, devices: [{ deviceId: 'dev-phone-0A', name: 'Handy', linkedAt: 0, kind: 'phone' }] },
    });
    await b.start();
    expect([a.runsAutomationActions, b.runsAutomationActions]).toEqual([true, false]);
    const got = chats(max);
    await max.sendCheckin({ to: [LISA], kind: 'arrived' });
    await flush();
    expect(got.filter((t) => t.includes('Denk an dich'))).toHaveLength(1);
  });

  it('falls back to the usual rule when it names a device that is not in the list', async () => {
    const { phone, pc } = await lisaOnTwoDevices(() => []);
    for (const n of [phone, pc]) {
      const s = n.getState();
      const other = new SocialNode({ transport: new MemoryNetwork().createTransport(LISA), initialState: { ...s, automationDevice: 'dev-gone-0001' }, deviceKind: n === pc ? 'computer' : 'phone' });
      expect(other.automationDevice).toBeUndefined();
      expect(other.runsAutomationActions).toBe(n === phone);
    }
  });

  it('is cleared, also on my other devices, when that device is removed from the list', async () => {
    const tablet: LinkedDevice = { deviceId: 'dev-tab-0001', name: 'Tablet', linkedAt: 0 };
    const { phone, pc } = await lisaOnTwoDevices(() => [], [{ deviceId: 'dev-phone-01', name: 'Handy', linkedAt: 0 }, tablet], [{ deviceId: 'dev-desk-001', name: 'PC', linkedAt: 0 }, tablet]);
    phone.setAutomationDevice('dev-desk-001');
    await phone.flushSync();
    await flush();
    expect(pc.runsAutomationActions).toBe(true);
    phone.removeDevice('dev-desk-001');
    expect(phone.getState().automationDevice).toBeUndefined();
    expect(phone.runsAutomationActions).toBe(true);
    await phone.flushSync();
    await flush();
    // Whatever still runs with the account hears of it and goes back to the usual rule too.
    expect(pc.getState().automationDevice).toBeUndefined();
    expect(pc.runsAutomationActions).toBe(false);
  });

  it('can be set back to automatic, and only to a device in the list', async () => {
    const { phone } = await lisaOnTwoDevices(() => []);
    expect(() => phone.setAutomationDevice('dev-unknown-01')).toThrow();
    phone.setAutomationDevice('dev-phone-01');
    expect(phone.automationDevice).toBe('dev-phone-01');
    phone.setAutomationDevice(undefined);
    expect(phone.automationDevice).toBeUndefined();
  });

  it('comes along when linking a device and in a backup; settings without it still sync as before', () => {
    const lisa = { ...state(LISA, 'Lisa', 'dev-phone-01'), automationDevice: 'dev-phone-01', syncRev: { automationDevice: 5 } };
    const doc = buildSyncDoc(lisa);
    expect(parseSyncDoc(JSON.parse(JSON.stringify(doc)))?.automationDevice).toBe('dev-phone-01');
    const linked = createLinkedState(
      { accountKey: LISA, secretKey: 'a'.repeat(64), relays: RELAY, deviceId: 'dev-phone-01', deviceName: 'Handy', devices: [], doc },
      { deviceId: 'dev-desk-001', deviceName: 'PC' },
      1000,
    );
    expect(linked.automationDevice).toBe('dev-phone-01');
    expect(normalizeState(JSON.parse(JSON.stringify(lisa)) as NodeState).automationDevice).toBe('dev-phone-01');
    // Older versions read settings strictly: a doc without a choice carries no new field.
    expect('automationDevice' in buildSyncDoc(state(LISA, 'Lisa'))).toBe(false);
  });
});

describe('names in what automations send', () => {
  it('a nickname only I use never reaches others', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    const oma = w.make(OMA, 'Oma Ilse');
    for (const n of [lisa, max, oma]) await n.start();
    await w.pair(lisa, max);
    await w.pair(lisa, oma);
    lisa.updateContact(OMA, { nickname: 'Drachen-Oma' });
    lisa.setRules([rule('core.sos-forward', { contact: OMA, other: MAX })]);
    oma.updateContact(LISA, { emergency: true });
    const got = chats(max);
    await oma.startSos({});
    await flush();
    expect(got).toEqual(['🆘 Oma Ilse hat in Heyda. einen Notruf ausgelöst. Bitte melde dich bei mir!']);
  });
});
