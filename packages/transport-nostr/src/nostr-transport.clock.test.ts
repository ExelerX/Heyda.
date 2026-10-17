import { composeMessage, type IncomingMessage } from '@heyda/core';
import type { Filter } from 'nostr-tools/filter';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySeenStore, NostrTransport } from './nostr-transport';
import { MemoryRelayPool, SimpleRelayPool } from './pool';
import { FakeRelayNetwork, until } from './test/fake-relay';

/**
 * Regression tests for senders whose clock runs behind (set by hand, wrong time zone). Relays apply
 * a filter's `since` to live events too, so a live subscription that shared the catch-up filter
 * kept out everything such a sender sent, an SOS included, and so did every catch-up after a
 * reconnect. Each test first reproduced the message being lost.
 */

const R = 'wss://relay.example';
const A = 'wss://relay-a.example';
const HOUR = 3600_000;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const textsOf = (inbox: IncomingMessage[]) => inbox.map((m) => (m.message.type === 'chat.text' ? m.message.text : m.message.type));
const chat = (text: string) => composeMessage({ type: 'chat.text', text });

/** Bob's phone and Alice, whose clock runs `behindMs` behind, on one in-memory relay. */
function world(behindMs: number) {
  let clock = Date.UTC(2026, 9, 10, 12);
  const now = () => clock;
  const pool = new MemoryRelayPool();
  const bobKey = generateSecretKey();
  const bob = (seen: MemorySeenStore, accept?: (from: string) => boolean) =>
    new NostrTransport({ secretKey: bobKey, ownRelays: [R], relaysFor: () => [R], pool, now, seen, ...(accept ? { accept } : {}) });
  const aliceKey = generateSecretKey();
  const alice = new NostrTransport({ secretKey: aliceKey, ownRelays: [R], relaysFor: () => [R], pool, now: () => clock - behindMs });
  return { tick: (ms: number) => (clock += ms), nowS: () => Math.floor(clock / 1000), bob, bobPub: getPublicKey(bobKey), alice, alicePub: getPublicKey(aliceKey) };
}

describe('a sender whose clock runs behind', () => {
  it('gets through live, whatever the created_at of their wrap', async () => {
    const { bob, bobPub, alice, tick, nowS } = world(3 * HOUR);
    const seen = new MemorySeenStore();
    // Synced a minute ago: the catch-up asks only for the last two hours or so.
    seen.setSyncedUntil(R, nowS() - 60);
    const phone = bob(seen);
    const inbox: IncomingMessage[] = [];
    phone.onMessage((m) => inbox.push(m));
    await phone.start();
    tick(60_000);
    await alice.send(bobPub, chat('Hilfe'));
    expect(textsOf(inbox)).toEqual(['Hilfe']);
  });

  it('asks a real relay for live events without since and without stored ones, and still catches up and reports it', async () => {
    const net = new FakeRelayNetwork();
    const relay = net.add(A);
    useWebSocketImplementation(net.WebSocket);
    const make = (key: Uint8Array, now?: () => number, seen?: MemorySeenStore) => {
      const pool = new SimpleRelayPool({ reconnectDelaysMs: [20, 40], probeEveryMs: 100, timeoutMs: 300 });
      const t = new NostrTransport({ secretKey: key, ownRelays: [A], relaysFor: () => [A], pool, now, seen });
      cleanup.push(
        () => t.stop(),
        () => pool.close(),
      );
      return t;
    };
    const bobKey = generateSecretKey();
    const bobPub = getPublicKey(bobKey);
    // Waiting on the relay from before: the catch-up brings it.
    await make(generateSecretKey()).send(bobPub, chat('vorher'));
    const seen = new MemorySeenStore();
    // Bob synced a minute ago: his catch-up asks only for the last two hours or so.
    seen.setSyncedUntil(A, Math.floor(Date.now() / 1000) - 60);
    const phone = make(bobKey, undefined, seen);
    const inbox: IncomingMessage[] = [];
    phone.onMessage((m) => inbox.push(m));
    let caughtUp = false;
    await phone.start();
    void phone.caughtUp().then(() => (caughtUp = true));
    await until(() => caughtUp, 3000, 'caught up');
    expect(textsOf(inbox)).toEqual(['vorher']);
    const mine = relay.reqs.filter((r) => r[0]?.['#p']?.[0] === bobPub).map((r) => r[0]!);
    const live = mine.find((f: Filter) => f.limit === 0);
    expect(live).toBeDefined();
    expect(live!.since).toBeUndefined();
    expect(live!.until).toBeUndefined();
    expect(mine.some((f) => f.since !== undefined && f.limit !== 0)).toBe(true);
    // Alice's clock is three hours behind.
    const lagging = make(generateSecretKey(), () => Date.now() - 3 * HOUR);
    await lagging.send(bobPub, chat('Hilfe'));
    await until(() => inbox.length === 2, 3000, "Alice's live message");
    expect(textsOf(inbox)).toEqual(['vorher', 'Hilfe']);
  }, 10_000);

  it('is not missed by the catch-up after a reconnect once their lag is known, also after a restart', async () => {
    const { bob, bobPub, alice, tick } = world(3 * HOUR);
    const seen = new MemorySeenStore();
    let phone = bob(seen);
    const inbox: IncomingMessage[] = [];
    phone.onMessage((m) => inbox.push(m));
    await phone.start();
    tick(60_000);
    await alice.send(bobPub, chat('Bin unterwegs'));
    await phone.stop();
    // Bob's phone is in a tunnel for ten minutes, then the app restarts from what it saved.
    tick(10 * 60_000);
    await alice.send(bobPub, chat('Hilfe'));
    tick(60_000);
    phone = bob(MemorySeenStore.restore(JSON.parse(JSON.stringify(seen.snapshot()))));
    phone.onMessage((m) => inbox.push(m));
    await phone.start();
    expect(textsOf(inbox)).toEqual(['Bin unterwegs', 'Hilfe']);
  });

  it('keeps the catch-up window small while every clock is right', async () => {
    const { bob, bobPub, alice, tick, nowS } = world(0);
    const seen = new MemorySeenStore();
    const phone = bob(seen);
    await phone.start();
    tick(60_000);
    await alice.send(bobPub, chat('Hallo'));
    expect(seen.clockLag(nowS())).toBeLessThanOrEqual(1);
  });

  it('learns lags only from accepted senders, from the median of recent messages, and at most a day', async () => {
    const seen = new MemorySeenStore();
    const at = 1_800_000_000;
    // One late message among many right ones does not move it.
    for (const lag of [10_800, 10_800, 10_800, 5]) seen.noteClockLag('a'.repeat(64), lag, at);
    expect(seen.clockLag(at)).toBe(10_800);
    // A clock three days behind widens the window by a day only.
    for (let i = 0; i < 3; i++) seen.noteClockLag('b'.repeat(64), 3 * 86_400, at);
    expect(seen.clockLag(at)).toBe(86_400);
    // Forgotten once nothing came from them for longer than messages are kept.
    expect(seen.clockLag(at + 9 * 86_400)).toBe(0);

    const { bob, bobPub, alice, tick, nowS } = world(3 * HOUR);
    const strangerSeen = new MemorySeenStore();
    const phone = bob(strangerSeen, () => false);
    await phone.start();
    tick(60_000);
    await alice.send(bobPub, chat('Wer bin ich?'));
    expect(strangerSeen.clockLag(nowS())).toBe(0);
  });
});

describe('whether every relay was live at a time', () => {
  it('says since when, not while a relay connection is down, and again once it caught up', async () => {
    const net = new FakeRelayNetwork();
    const relayA = net.add(A);
    const relayB = net.add('wss://relay-b.example');
    useWebSocketImplementation(net.WebSocket);
    const pool = new SimpleRelayPool({ reconnectDelaysMs: [50, 50], probeEveryMs: 100, timeoutMs: 300 });
    const bob = new NostrTransport({ secretKey: generateSecretKey(), ownRelays: [A, relayB.url], relaysFor: () => [A], pool });
    cleanup.push(
      () => bob.stop(),
      () => pool.close(),
    );
    expect(bob.liveSince()).toBeUndefined();
    const before = Date.now();
    await bob.start();
    await bob.caughtUp();
    const since = bob.liveSince();
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());
    // Relay A drops Bob for a while.
    relayA.down = true;
    relayA.dropWhere((c) => c.listensFor(bob.selfKey));
    await until(() => bob.liveSince() === undefined, 2000, 'gap noticed');
    const dropped = Date.now();
    relayA.down = false;
    await until(() => bob.liveSince() !== undefined, 3000, 'live again');
    expect(bob.liveSince()).toBeGreaterThanOrEqual(dropped);
    await bob.stop();
    expect(bob.liveSince()).toBeUndefined();
  }, 10_000);
});

describe('learning how far a clock lags', () => {
  it('ignores what a frozen app gets handed only when it runs again: that is not live', async () => {
    const net = new FakeRelayNetwork();
    const relay = net.add(A);
    useWebSocketImplementation(net.WebSocket);
    let shift = 0;
    const make = (key: Uint8Array, seen?: MemorySeenStore) => {
      const pool = new SimpleRelayPool({ reconnectDelaysMs: [20, 40], probeEveryMs: 50, timeoutMs: 20_000 });
      const t = new NostrTransport({ secretKey: key, ownRelays: [A], relaysFor: () => [A], pool, seen, now: () => Date.now() + shift });
      cleanup.push(
        () => t.stop(),
        () => pool.close(),
      );
      return t;
    };
    const seen = new MemorySeenStore();
    const bob = make(generateSecretKey(), seen);
    const inbox: IncomingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    await bob.start();
    await bob.caughtUp();
    await new Promise((r) => setTimeout(r, 20));
    // The app is frozen in the background: its socket keeps what comes, nothing runs.
    for (const c of relay.connections) if (c.listensFor(bob.selfKey)) c.holding = true;
    const alice = make(generateSecretKey());
    await alice.send(bob.selfKey, chat('Bin gleich da'));
    const frozenUntil = Date.now() + 200;
    while (Date.now() < frozenUntil) {
      // busy: timers are overdue, like after hours in the background
    }
    shift = 2 * HOUR;
    for (const c of relay.connections) if (c.listensFor(bob.selfKey)) c.release();
    await until(() => inbox.length === 1, 3000, 'the message');
    expect(seen.clockLag(Math.floor((Date.now() + shift) / 1000))).toBe(0);
  }, 10_000);
});
