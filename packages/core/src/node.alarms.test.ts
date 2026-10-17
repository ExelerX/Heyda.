import { describe, expect, it } from 'vitest';
import { restoredState } from './backup/backup';
import { alarmAlert } from './notify/alarm';
import { SocialNode, type NodeEvent, type SocialNodeOptions } from './node';
import type { AppMessage } from './protocol/messages';
import { createInitialState, type Alarm, type Alert, type NodeState } from './state';
import { MemoryNetwork, type MemoryTransport } from './transport/memory';
import type { IncomingMessage, SendOptions, Transport } from './transport/transport';

/**
 * Regression tests for alarms the platform rings itself: my own watch reminders after a restore,
 * how the Windows app files an alarm that rang, and a laptop that slept through a deadline while
 * the check-in that calls it off waited on the relays. Each one first reproduced the problem.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const RELAY = ['wss://relay.example'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function state(key: string, name: string, deviceId = `dev-${name}-00`): NodeState {
  return createInitialState({ key, name, relays: RELAY, deviceId, deviceName: `${name}s Handy` });
}

const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

function events(node: SocialNode): NodeEvent[] {
  const out: NodeEvent[] = [];
  node.on((e) => out.push(e));
  return out;
}

function alerts(node: SocialNode): Alert[] {
  const out: Alert[] = [];
  node.on((e) => e.type === 'alert' && out.push(e.alert));
  return out;
}

/**
 * A relay subscription on a laptop that can sleep: while asleep nothing arrives (it waits on the
 * relays), and after waking `caughtUpAgain()` resolves once `resynced()` says everything is in.
 */
class SleepyRelay implements Transport {
  private waiters: (() => void)[] = [];
  asked = 0;
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
  send(to: string, message: AppMessage, options?: SendOptions): Promise<void> {
    return this.inner.send(to, message, options);
  }
  onMessage(handler: (m: IncomingMessage) => void): () => void {
    return this.inner.onMessage(handler);
  }
  async caughtUp(): Promise<void> {}
  caughtUpAgain(): Promise<void> {
    this.asked++;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  sleep(): Promise<void> {
    return this.inner.stop();
  }
  /** Woken up: the connection is back and what waited arrives. */
  async wake(): Promise<void> {
    await this.inner.start();
    await flush();
  }
  resynced(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

function world() {
  let clock = 30 * DAY;
  const now = () => clock;
  const net = new MemoryNetwork();
  const make = (key: string, name: string, extra: Partial<SocialNodeOptions> = {}, initial = state(key, name)) =>
    new SocialNode({ transport: net.createTransport(key, now), initialState: initial, now, localTime, syncDelayMs: 0, ...extra });
  return { net, now, tick: (ms: number) => (clock += ms), make };
}

describe('my own watch reminders after a restore or link', () => {
  async function restoredWithWatch(dueInMs: number) {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await lisa.acceptInvite(max.createInvite());
    await flush();
    const watchId = await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + dueInMs });
    await flush();
    // Same account, restored from a backup: the app cleared every alarm the OS had for the old data.
    const old = lisa.getState();
    await lisa.stop();
    const restored = restoredState({ ...old, self: { ...old.self, deviceId: 'dev-new-phone1', deviceName: 'Neues Handy' } }, w.now());
    const again = new SocialNode({ transport: w.net.createTransport(LISA, w.now), initialState: restored, now: w.now, localTime, syncDelayMs: 0 });
    const got = events(again);
    await again.start();
    const scheduled = got.flatMap((e) => (e.type === 'alarm.schedule' ? [e.alarm] : []));
    return { ...w, again, watchId, scheduled, got };
  }

  it('schedules the reminder and the deadline alarm of a watch still running again', async () => {
    const { scheduled, watchId, now } = await restoredWithWatch(2 * HOUR);
    const due = now() + 2 * HOUR;
    expect(scheduled.map((a) => [a.id, a.at, a.level])).toEqual(
      expect.arrayContaining([
        [`mywatch:${watchId}:remind`, due - 10 * MIN, 'normal'],
        [`mywatch:${watchId}:due`, due, 'alarm'],
      ]),
    );
    expect(scheduled.find((a) => a.id.endsWith(':due'))?.title).toBe('⏰ Deine Zeit ist abgelaufen');
  });

  it('schedules only the deadline when the reminder time has passed, and cancels nothing', async () => {
    const { scheduled, watchId, got } = await restoredWithWatch(5 * MIN);
    expect(scheduled.map((a) => a.id)).toEqual([`mywatch:${watchId}:due`]);
    expect(got.filter((e) => e.type === 'alarm.cancel')).toEqual([]);
  });

  it('a newly linked device gets my running watch and reminds me too, also one started before it existed', async () => {
    const w = world();
    const phone = w.make(LISA, 'Lisa', {}, state(LISA, 'Lisa', 'dev-phone-0001'));
    const max = w.make(MAX, 'Max');
    await phone.start();
    await max.start();
    await phone.acceptInvite(max.createInvite());
    await flush();
    // Started while the phone was my only device: nothing went to other devices.
    const watchId = await phone.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + 2 * HOUR });
    await flush();
    // The PC gets the account (contacts and settings, no watches) and tells my other devices.
    const linked: NodeState = { ...phone.getState(), self: { ...phone.getState().self, deviceId: 'dev-pc-00000001', deviceName: 'PC' }, watches: [], devices: [{ deviceId: 'dev-phone-0001', name: 'Handy', linkedAt: w.now() }] };
    const pc = new SocialNode({ transport: w.net.createTransport(LISA, w.now), initialState: linked, now: w.now, localTime, syncDelayMs: 0, deviceKind: 'computer' });
    const got = events(pc);
    await pc.start();
    await pc.announceLinked();
    await flush();
    expect(pc.getState().watches.map((x) => x.watchId)).toEqual([watchId]);
    const scheduled = got.flatMap((e) => (e.type === 'alarm.schedule' ? [e.alarm.id] : []));
    expect(scheduled).toEqual(expect.arrayContaining([`mywatch:${watchId}:remind`, `mywatch:${watchId}:due`]));
  });

  it('does not ring a deadline that already passed again', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await lisa.acceptInvite(max.createInvite());
    await flush();
    await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + 30 * MIN });
    await flush();
    await lisa.stop();
    w.tick(HOUR);
    const again = new SocialNode({ transport: w.net.createTransport(LISA, w.now), initialState: lisa.getState(), now: w.now, localTime, syncDelayMs: 0 });
    const got = events(again);
    await again.start();
    expect(got.filter((e) => e.type === 'alarm.schedule')).toEqual([]);
  });
});

describe('an alarm the platform rang itself', () => {
  const alarm = (id: string, level: Alarm['level']): Alarm => ({ id, at: 1000, title: 'T', body: 'B', level });

  it("files a contact's watch under watch and leads to that contact, also when it is not loud", () => {
    for (const level of ['alarm', 'normal', 'silent'] as const) {
      expect(alarmAlert(alarm(`watch:${LISA}:w-123456`, level), 2000)).toEqual({
        id: `watch:${LISA}:w-123456`,
        at: 2000,
        category: 'watch',
        level,
        title: 'T',
        body: 'B',
        from: LISA,
        thread: LISA,
        ref: { watchId: 'w-123456' },
      });
    }
  });

  it('files my own reminders under watch, without a sender', () => {
    expect(alarmAlert(alarm('mywatch:w-123456:remind', 'normal'), 2000)).toMatchObject({ category: 'watch', ref: { watchId: 'w-123456' } });
    expect(alarmAlert(alarm('mywatch:w-123456:due', 'alarm'), 2000)).toMatchObject({ category: 'watch', ref: { watchId: 'w-123456' } });
    expect(alarmAlert(alarm('mywatch:w-123456:due', 'alarm'), 2000).from).toBeUndefined();
  });

  it('matches the alert the node raises itself for an overdue watch', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await max.acceptInvite(lisa.createInvite());
    await flush();
    const scheduled: Alarm[] = [];
    max.on((e) => e.type === 'alarm.schedule' && scheduled.push(e.alarm));
    const got = alerts(max);
    await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + 30 * MIN });
    await flush();
    w.tick(31 * MIN);
    await max.tick();
    const core = got.find((a) => a.category === 'watch')!;
    const own = alarmAlert(scheduled[0]!, core.at);
    expect({ ...own, level: core.level }).toEqual(core);
  });
});

describe('a laptop that slept through a deadline', () => {
  /**
   * Lisa watches over herself until 22:30 with Max, whose laptop runs. At 22:20 it goes to sleep;
   * Lisa's check-in (or nothing) waits on the relays. At 22:35 it wakes up again.
   */
  async function sleptOverDeadline(lisaChecksIn: boolean, extra: Partial<SocialNodeOptions> = {}) {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const relay = new SleepyRelay(w.net.createTransport(MAX, w.now));
    const max = new SocialNode({ transport: relay, initialState: state(MAX, 'Max'), now: w.now, localTime, syncDelayMs: 0, deviceKind: 'computer', ...extra });
    await lisa.start();
    await max.start();
    await max.acceptInvite(lisa.createInvite());
    await flush();
    const watchId = await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + 30 * MIN });
    await flush();
    const got = alerts(max);
    w.tick(20 * MIN);
    await max.tick();
    await relay.sleep();
    w.tick(5 * MIN);
    if (lisaChecksIn) {
      await lisa.endWatch(watchId, 'ok');
      await flush();
    }
    w.tick(10 * MIN);
    const watchAlarms = () => got.filter((a) => a.category === 'watch');
    return { ...w, max, relay, got, watchAlarms, watchId };
  }

  it('rings no overdue watch on its first tick after waking, and none once the check-in is in', async () => {
    const { max, relay, got, watchAlarms } = await sleptOverDeadline(true);
    // The timer of the app fires first, before the connection is back.
    await max.tick();
    expect(watchAlarms()).toEqual([]);
    expect(relay.asked).toBe(1);
    await relay.wake();
    relay.resynced();
    await flush();
    await max.tick();
    expect(watchAlarms()).toEqual([]);
    expect(got.map((a) => a.body)).toContain('✅ hat sich gemeldet („Heimweg“)');
  });

  it('rings the overdue watch once the relays caught up again without a check-in', async () => {
    const { max, relay, watchAlarms } = await sleptOverDeadline(false);
    await max.tick();
    expect(watchAlarms()).toEqual([]);
    await relay.wake();
    relay.resynced();
    await flush();
    expect(watchAlarms().map((a) => a.title)).toEqual(['⏰ Lisa hat sich nicht gemeldet']);
    await max.tick();
    expect(watchAlarms()).toHaveLength(1);
  });

  it('rings it anyway after a short while when the relays never say so', async () => {
    const { max, watchAlarms } = await sleptOverDeadline(false, { backlogWaitMs: 30 });
    await max.tick();
    expect(watchAlarms()).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(watchAlarms()).toHaveLength(1);
  });

  it('lets the platform wait the same way for an alarm timer that fired late, and tells it when the watch ended', async () => {
    const { max, relay, watchAlarms, watchId } = await sleptOverDeadline(true);
    let done = false;
    const waited = max.catchUpAgain().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    await relay.wake();
    relay.resynced();
    await waited;
    expect(max.getStatus(LISA).watches?.some((x) => x.watchId === watchId) ?? false).toBe(false);
    expect(watchAlarms()).toEqual([]);
    // The timer and the next tick share one wait.
    expect(relay.asked).toBe(1);
  });

  it('does not wait after a short pause between ticks, or when no deadline passed meanwhile', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const relay = new SleepyRelay(w.net.createTransport(MAX, w.now));
    const max = new SocialNode({ transport: relay, initialState: state(MAX, 'Max'), now: w.now, localTime, syncDelayMs: 0 });
    await lisa.start();
    await max.start();
    await max.acceptInvite(lisa.createInvite());
    await flush();
    const got = alerts(max);
    await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + 30 * MIN });
    await flush();
    w.tick(10 * MIN);
    await max.tick();
    // A long pause, but no deadline passed in it: nothing to wait for.
    w.tick(15 * MIN);
    await max.tick();
    expect(relay.asked).toBe(0);
    // The deadline passed only half a minute ago: rings as before.
    w.tick(5 * MIN + 30_000);
    await max.tick();
    expect(relay.asked).toBe(0);
    expect(got.filter((a) => a.category === 'watch')).toHaveLength(1);
  });
});
