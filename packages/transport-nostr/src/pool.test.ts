import { composeMessage, type IncomingMessage } from '@heyda/core';
import type { Filter } from 'nostr-tools/filter';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySeenStore, NostrTransport } from './nostr-transport';
import { SimpleRelayPool } from './pool';
import { FakeRelayNetwork, until } from './test/fake-relay';

/** Regression tests for relay reconnects and catch-up, against a fake NIP-01 relay. */

const A = 'wss://relay-a.example';
const B = 'wss://relay-b.example';
const FAST = { reconnectDelaysMs: [20, 40], probeEveryMs: 100, timeoutMs: 300 };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

function world(caps: Record<string, number> = {}) {
  const net = new FakeRelayNetwork();
  const relayA = net.add(A, caps[A]);
  const relayB = net.add(B, caps[B]);
  useWebSocketImplementation(net.WebSocket);
  const pool = () => {
    const p = new SimpleRelayPool(FAST);
    cleanup.push(() => p.close());
    return p;
  };
  const transport = (opts: { key?: Uint8Array; own: string[]; to: string[]; seen?: MemorySeenStore; now?: () => number }) => {
    const t = new NostrTransport({
      secretKey: opts.key ?? generateSecretKey(),
      ownRelays: opts.own,
      relaysFor: () => opts.to,
      pool: pool(),
      seen: opts.seen,
      now: opts.now,
    });
    cleanup.push(() => t.stop());
    return t;
  };
  return { net, relayA, relayB, transport };
}

const texts = (inbox: IncomingMessage[], prefix: string) =>
  inbox.filter((m) => m.message.type === 'chat.text' && m.message.text.startsWith(prefix)).length;
const chat = (text: string) => composeMessage({ type: 'chat.text', text });
const sinceOf = (reqs: Filter[][], key: string) => reqs.filter((r) => r[0]?.['#p']?.[0] === key).map((r) => r[0]!);

describe('SimpleRelayPool', () => {
  it('still gets everything after a relay connection drops, and keeps every other relay working', async () => {
    const { relayA, transport } = world();
    const bobKey = generateSecretKey();
    const bob = transport({ key: bobKey, own: [A, B], to: [A, B] });
    const viaA = transport({ own: [A], to: [A] });
    const viaB = transport({ own: [B], to: [B] });
    const inbox: IncomingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    await bob.start();
    await until(() => relayA.connections.size > 0, 2000, 'bob connected');

    for (let i = 0; i < 10; i++) await viaA.send(bob.selfKey, chat(`vorher ${i}`), { ttlSeconds: 86400 });
    await until(() => texts(inbox, 'vorher') === 10, 2000, 'messages before the drop');

    // Bob's connection to relay A goes away and he cannot reach A for a while. Others still can.
    relayA.down = true;
    relayA.dropWhere((c) => c.listensFor(bob.selfKey));
    for (let i = 0; i < 20; i++) await viaA.send(bob.selfKey, chat(`während ${i}`), { ttlSeconds: 86400 });
    relayA.down = false;

    await until(() => texts(inbox, 'während') === 20, 15_000, 'messages sent during the drop');
    for (let i = 0; i < 10; i++) await viaA.send(bob.selfKey, chat(`danach A ${i}`), { ttlSeconds: 86400 });
    for (let i = 0; i < 10; i++) await viaB.send(bob.selfKey, chat(`danach B ${i}`), { ttlSeconds: 86400 });
    await until(() => texts(inbox, 'danach A') === 10 && texts(inbox, 'danach B') === 10, 5000, 'live messages afterwards');
    expect(inbox).toHaveLength(50);
  }, 30_000);

  it('pages past the per-request cap of a relay, so a long backlog arrives in full', async () => {
    let clock = 1_800_000_000_000;
    const now = () => clock;
    // strfry (damus, nos.lol) caps every request at 500 stored events; a smaller cap keeps this test fast.
    const { relayA, transport } = world({ [A]: 100 });
    const bobKey = generateSecretKey();
    const bobPub = getPublicKey(bobKey);
    const alice = transport({ own: [A], to: [A], now });
    const carol = transport({ own: [A], to: [A], now });
    // Bob's phone is off while Alice drives with a precise live share and Carol writes in between.
    let chats = 0;
    for (let i = 0; i < 300; i++) {
      clock += 15_000;
      await alice.send(bobPub, composeMessage({ type: 'live.update', shareId: 'share-0001', point: { lat: 52, lon: 13, accuracyM: 5 } }, clock), { ttlSeconds: 3600 });
      if (i % 15 === 0) {
        chats++;
        await carol.send(bobPub, composeMessage({ type: 'chat.text', text: `Chat ${i}` }, clock), { ttlSeconds: 7 * 86400 });
      }
    }
    expect(relayA.events.length).toBe(320);

    const bob = transport({ key: bobKey, own: [A], to: [A], now });
    const inbox: IncomingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    await bob.start();
    await until(() => texts(inbox, 'Chat') === chats, 15_000, 'all chats');
    await until(() => inbox.length === 300 + chats, 5000, 'all live updates');
  }, 60_000);

  it('remembers per relay how far it got, so the next start only asks for the recent window', async () => {
    let clock = 1_800_000_000_000;
    const now = () => clock;
    const { relayA, transport } = world();
    const bobKey = generateSecretKey();
    const seen = new MemorySeenStore();
    const first = transport({ key: bobKey, own: [A], to: [A], seen, now });
    await first.start();
    await until(() => seen.syncedUntil(A) > 0, 2000, 'catch-up done');
    expect(seen.syncedUntil(A)).toBe(Math.floor(clock / 1000) - 60);
    await first.stop();

    // A day later the app starts again with what it saved.
    clock += 86_400_000;
    const restored = MemorySeenStore.restore(JSON.parse(JSON.stringify(seen.snapshot())));
    const second = transport({ key: bobKey, own: [A], to: [A], seen: restored, now });
    await second.start();
    await until(() => sinceOf(relayA.reqs, second.selfKey).length >= 2, 2000, 'second REQ');
    const since = sinceOf(relayA.reqs, second.selfKey).at(-1)!.since!;
    // Wraps are backdated by up to an hour, so it looks back that far before the last sync, plus an
    // hour for senders whose clock runs behind.
    expect(since).toBe(seen.syncedUntil(A) - 2 * 3600);
  }, 10_000);

  it('keeps trying a relay that was unreachable at start', async () => {
    const { relayA, transport } = world();
    relayA.down = true;
    const bob = transport({ own: [A], to: [A] });
    const alice = transport({ own: [B], to: [A] });
    const inbox: IncomingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    await bob.start();
    await new Promise((r) => setTimeout(r, 100));
    relayA.down = false;
    await alice.send(bob.selfKey, chat('bist du da?'));
    await until(() => inbox.length === 1, 5000, 'message after the relay came back');
  }, 10_000);

  it('renews a connection that stopped answering, and fetches what it missed', async () => {
    const { relayA, transport } = world();
    const bob = transport({ own: [A], to: [A] });
    const alice = transport({ own: [A], to: [A] });
    const inbox: IncomingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    await bob.start();
    await until(() => relayA.connections.size > 0, 2000, 'bob connected');
    await alice.send(bob.selfKey, chat('eins'));
    await until(() => inbox.length === 1, 2000, 'first message');

    // Bob's socket still looks open, but nothing comes through any more.
    for (const c of relayA.connections) if (c.listensFor(bob.selfKey)) c.stalled = true;
    await alice.send(bob.selfKey, chat('zwei'));
    await until(() => inbox.length === 2, 5000, 'message sent while the connection hung');
  }, 10_000);

  it('renews the connection right after the device slept, without waiting for a timeout', async () => {
    const net = new FakeRelayNetwork();
    const relayA = net.add(A);
    useWebSocketImplementation(net.WebSocket);
    const make = (key?: Uint8Array) => {
      const pool = new SimpleRelayPool({ ...FAST, probeEveryMs: 50, timeoutMs: 20_000 });
      const t = new NostrTransport({ secretKey: key ?? generateSecretKey(), ownRelays: [A], relaysFor: () => [A], pool });
      cleanup.push(() => t.stop(), () => pool.close());
      return t;
    };
    const bob = make();
    const alice = make();
    const inbox: IncomingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    await bob.start();
    await until(() => relayA.connections.size > 0, 2000, 'bob connected');
    await new Promise((r) => setTimeout(r, 20));

    // The laptop sleeps: timers stop, and the socket dies without a word.
    for (const c of relayA.connections) if (c.listensFor(bob.selfKey)) c.stalled = true;
    const asleepUntil = Date.now() + 200;
    while (Date.now() < asleepUntil) {
      // busy: nothing else runs, like a frozen app
    }
    await alice.send(bob.selfKey, chat('guten Morgen'));
    // Far sooner than the 20 s a silent connection would take to time out.
    await until(() => inbox.length === 1, 3000, 'message after waking up');
  }, 10_000);
});
