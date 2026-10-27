import { describe, expect, it } from 'vitest';
import { SocialNode, type SocialNodeOptions } from './node';
import type { AppMessage, AppMessageBody } from './protocol/messages';
import { createInitialState, type Alert, type Contact, type NodeState } from './state';
import { MemoryNetwork, type MemoryTransport } from './transport/memory';
import type { IncomingMessage, SendOptions, Transport } from './transport/transport';

/**
 * Regression tests for a device starting after it was off (a PC shut down overnight): deadlines
 * that passed meanwhile must not ring before what waited on the relays has arrived, since the
 * end or check-in that calls them off may be among it. Each one first reproduced the problem.
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

const contact = (key: string, name: string): Contact => ({ key, name, relays: RELAY, addedAt: 0, verified: true });

const localTime = (now: number) => ({ minutes: Math.floor(now / 60_000) % 1440, weekday: 3 });

function alerts(node: SocialNode): Alert[] {
  const out: Alert[] = [];
  node.on((e) => e.type === 'alert' && out.push(e.alert));
  return out;
}

/**
 * Like a relay subscription: `start()` returns at once, what waited while the device was off
 * arrives a moment later (`deliverBacklog`), and `caughtUp()` tells when it is all in.
 */
class RelayLike implements Transport {
  private release!: () => void;
  private readonly done = new Promise<void>((r) => (this.release = r));
  constructor(private readonly inner: MemoryTransport) {}
  get selfKey(): string {
    return this.inner.selfKey;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    await this.inner.stop();
  }
  send(to: string, message: AppMessage, options?: SendOptions): Promise<void> {
    return this.inner.send(to, message, options);
  }
  onMessage(handler: (m: IncomingMessage) => void): () => void {
    return this.inner.onMessage(handler);
  }
  caughtUp(): Promise<void> {
    return this.done;
  }
  async deliverBacklog(): Promise<void> {
    await this.inner.start();
    this.release();
  }
}

function world() {
  let clock = 30 * DAY;
  const now = () => clock;
  const net = new MemoryNetwork();
  const make = (key: string, name: string, initial = state(key, name)) =>
    new SocialNode({ transport: net.createTransport(key, now), initialState: initial, now, localTime, syncDelayMs: 0 });
  /** The same device started again with what it saved, on `transport`. */
  const restart = (node: SocialNode, transport: Transport, extra: Partial<SocialNodeOptions> = {}) =>
    new SocialNode({ transport, initialState: node.getState(), initialStatuses: node.exportStatuses(), now, localTime, syncDelayMs: 0, ...extra });
  /** Sends a hand-made message as `from`, with the sender's clock at `sentAt`. */
  const forge = (from: string) => {
    const t = net.createTransport(from, now);
    let n = 0;
    return async (to: string, body: AppMessageBody, sentAt = clock) => {
      await t.send(to, { ...body, v: 1, id: `forged-${from.slice(0, 4)}-${String(n++).padStart(6, '0')}`, sentAt } as AppMessage);
      await flush();
    };
  };
  return { net, now, tick: (ms: number) => (clock += ms), make, restart, forge };
}

/**
 * Lisa watches over herself until 23:00 with Max. Max shuts his PC down at 21:00; whatever Lisa
 * sends after that waits on the relays. He starts it again the next morning.
 */
async function pcOffOverDeadline(lisaChecksIn: boolean, extra: Partial<SocialNodeOptions> = {}) {
  const w = world();
  const lisa = w.make(LISA, 'Lisa');
  const max = w.make(MAX, 'Max');
  await lisa.start();
  await max.start();
  await max.acceptInvite(lisa.createInvite());
  await flush();
  const watchId = await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + 3 * HOUR });
  await flush();
  expect(max.getStatus(LISA).watches?.map((x) => x.watchId)).toEqual([watchId]);
  w.tick(HOUR);
  await max.stop();
  const relay = new RelayLike(w.net.createTransport(MAX, w.now));
  w.tick(HOUR + 45 * MIN);
  if (lisaChecksIn) {
    await lisa.endWatch(watchId, 'ok');
    await flush();
  }
  w.tick(9 * HOUR + 15 * MIN);
  const again = w.restart(max, relay, extra);
  const got = alerts(again);
  await again.start();
  const watchAlarms = () => got.filter((a) => a.category === 'watch');
  return { ...w, lisa, again, relay, got, watchAlarms };
}

describe('starting after the device was off', () => {
  it('rings no overdue watch before what waited on the relays is in, and none when its check-in is among it', async () => {
    const { again, relay, got, watchAlarms } = await pcOffOverDeadline(true);
    await again.tick();
    expect(watchAlarms()).toEqual([]);
    await relay.deliverBacklog();
    await flush();
    await again.tick();
    expect(watchAlarms()).toEqual([]);
    expect(got.map((a) => a.body)).toContain('✅ hat sich gemeldet („Heimweg“)');
    expect(again.getStatus(LISA).watches ?? []).toEqual([]);
  });

  it('rings an overdue watch once right after what waited is in, when no check-in is among it', async () => {
    const { again, relay, watchAlarms } = await pcOffOverDeadline(false);
    await again.tick();
    expect(watchAlarms()).toEqual([]);
    await relay.deliverBacklog();
    await flush();
    // Without waiting for the next tick.
    expect(watchAlarms().map((a) => [a.id.startsWith(`watch:${LISA}:`), a.title])).toEqual([[true, '⏰ Lisa hat sich nicht gemeldet']]);
    await again.tick();
    expect(watchAlarms()).toHaveLength(1);
  });

  it('rings it anyway after a while when the relays never say they are done (offline, a relay down)', async () => {
    const { again, watchAlarms } = await pcOffOverDeadline(false, { backlogWaitMs: 30 });
    await again.tick();
    expect(watchAlarms()).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(watchAlarms()).toHaveLength(1);
  });

  it('rings a watch that goes overdue later as before', async () => {
    const { again, relay, now, tick, lisa, watchAlarms } = await pcOffOverDeadline(true);
    await relay.deliverBacklog();
    await flush();
    await lisa.startWatch({ to: [MAX], label: 'Joggen', dueAt: now() + 30 * MIN });
    await flush();
    tick(31 * MIN);
    await again.tick();
    expect(watchAlarms().map((a) => a.body)).toEqual([expect.stringContaining('Joggen')]);
  });

  it('does not ring an SOS from before whose wait ran out while off before what waited is in', async () => {
    const w = world();
    // Lisa's PC just got her account; Max's SOS from before arrives and waits a moment for its end.
    const pc = w.make(LISA, 'Lisa', { ...state(LISA, 'Lisa', 'dev-pc-0001'), contacts: [contact(MAX, 'Max')], historyBefore: w.now() });
    await pc.start();
    const fromMax = w.forge(MAX);
    const sosId = 'sos-max-000001';
    await fromMax(LISA, { type: 'sos.start', sosId, text: 'Hilfe', others: [] }, w.now() - HOUR);
    expect(pc.getStatus(MAX).sos?.text).toBe('Hilfe');
    // The PC is shut down before the wait is over; the end comes while it is off.
    await pc.stop();
    const relay = new RelayLike(w.net.createTransport(LISA, w.now));
    await fromMax(LISA, { type: 'sos.end', sosId, reason: 'safe' }, w.now() - HOUR + 5 * MIN);
    w.tick(HOUR);
    const again = w.restart(pc, relay);
    const got = alerts(again);
    await again.start();
    await again.tick();
    expect(got).toEqual([]);
    await relay.deliverBacklog();
    await flush();
    await again.tick();
    expect(got.filter((a) => a.level === 'alarm')).toEqual([]);
    expect(again.getStatus(MAX).sos?.endedAt).toBeDefined();
  });

  it('does not ring a watch that is overdue longer than a watch is kept', async () => {
    const w = world();
    const lisa = w.make(LISA, 'Lisa');
    const max = w.make(MAX, 'Max');
    await lisa.start();
    await max.start();
    await max.acceptInvite(lisa.createInvite());
    await flush();
    await lisa.startWatch({ to: [MAX], label: 'Heimweg', dueAt: w.now() + HOUR });
    await flush();
    await max.stop();
    // Two days later.
    w.tick(2 * DAY);
    const again = w.restart(max, w.net.createTransport(MAX, w.now));
    const got = alerts(again);
    await again.start();
    await again.tick();
    expect(got.filter((a) => a.category === 'watch')).toEqual([]);
    expect(again.getStatus(LISA).watches ?? []).toEqual([]);
  });
});
