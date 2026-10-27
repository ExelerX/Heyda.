import { composeMessage, type AppMessage, type IncomingMessage } from '@heyda/core';
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { APP_RUMOR_KIND, GIFT_WRAP_KIND, MemorySeenStore, NostrTransport } from './nostr-transport';
import { MemoryRelayPool, type FeedHandlers, type RelayPool } from './pool';

/** Regression tests: what a catch-up hands over again, and what it costs. */

const RELAY = 'wss://relay.example';
const DAY = 86_400;
const MAX_AGE = 8 * DAY;

function world(accept?: (from: string) => boolean) {
  let clock = Date.now();
  const now = () => clock;
  const pool = new MemoryRelayPool();
  const bobKey = generateSecretKey();
  const bobPub = getPublicKey(bobKey);
  const bob = (seen: MemorySeenStore, onError?: (e: unknown) => void) =>
    new NostrTransport({
      secretKey: bobKey,
      ownRelays: [RELAY],
      relaysFor: () => [RELAY],
      pool,
      now,
      seen,
      onError,
      ...(accept ? { accept: (from: string) => accept(from) } : {}),
    });
  const sender = (key = generateSecretKey()) => new NostrTransport({ secretKey: key, ownRelays: [RELAY], relaysFor: () => [RELAY], pool, now });
  return { pool, now, nowS: () => Math.floor(clock / 1000), tick: (ms: number) => (clock += ms), bob, bobPub, sender };
}

const textsOf = (inbox: IncomingMessage[]) => inbox.map((m) => (m.message.type === 'chat.text' ? m.message.text : m.message.type));
const chat = (text: string) => composeMessage({ type: 'chat.text', text });

/** A gift wrap built by hand, for contents the transport would never send. */
function wrapOf(senderKey: Uint8Array, recipient: string, content: string, createdAt: number): NostrEvent {
  const rumor = createRumor({ kind: APP_RUMOR_KIND, content, created_at: createdAt }, senderKey);
  const seal = createSeal(rumor, senderKey, recipient);
  const oneTime = generateSecretKey();
  return finalizeEvent(
    { kind: GIFT_WRAP_KIND, content: nip44Encrypt(JSON.stringify(seal), getConversationKey(oneTime, recipient)), created_at: createdAt, tags: [['p', recipient]] },
    oneTime,
  );
}

/** Signed and addressed to `recipient`, but nobody can open it. */
function junkFor(recipient: string, createdAt: number): NostrEvent {
  return finalizeEvent({ kind: GIFT_WRAP_KIND, content: 'nicht lesbar', created_at: createdAt, tags: [['p', recipient]] }, generateSecretKey());
}

const randomId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('catch-up', () => {
  it('hands over no message twice, also when more arrived in the window than the store keeps by count', async () => {
    const { bob, sender, tick } = world();
    // By count it keeps (at least) 20 messages and 30 wraps; the app 5000 and 8000, which a busy
    // week of live locations passes.
    const seen = new MemorySeenStore(20, 30);
    const alice = sender();
    const first = bob(seen);
    const inbox: IncomingMessage[] = [];
    first.onMessage((m) => inbox.push(m));
    await first.start();
    for (let i = 0; i < 40; i++) {
      tick(60_000);
      await alice.send(first.selfKey, chat(`m${i}`));
    }
    expect(inbox).toHaveLength(40);

    // The app comes back from the background: a new catch-up of the same window.
    await first.stop();
    tick(10 * 60_000);
    await first.start();
    expect(inbox).toHaveLength(40);
    await first.stop();

    // An hour later the app starts again with what it saved.
    tick(3600_000);
    const second = bob(MemorySeenStore.restore(JSON.parse(JSON.stringify(seen.snapshot())), 20, 30));
    const again: IncomingMessage[] = [];
    second.onMessage((m) => again.push(m));
    await second.start();
    expect(textsOf(again)).toEqual([]);
  });

  it('forgets an id once a catch-up would drop its message for age anyway, but always keeps the newest', () => {
    const s = new MemorySeenStore(3, 3);
    const ids = Array.from({ length: 10 }, randomId);
    const wraps = Array.from({ length: 10 }, randomId);
    ids.forEach((id, i) => s.add(id, 1000 + i));
    wraps.forEach((id, i) => s.addWrap(id, 1000 + i));
    s.prune(999);
    expect(ids.every((id) => s.has(id)) && wraps.every((id) => s.hasWrap(id))).toBe(true);

    s.prune(1006);
    expect(ids.map((id) => s.has(id))).toEqual([false, false, false, false, false, false, true, true, true, true]);
    expect(wraps.map((id) => s.hasWrap(id))).toEqual([false, false, false, false, false, false, true, true, true, true]);

    // A clock that ran days ahead must not wipe everything that guards against replays.
    s.prune(1_000_000);
    expect(ids.map((id) => s.has(id))).toEqual([...Array(7).fill(false), true, true, true]);

    // Saved with short ids and their times, and read back the same.
    const saved = JSON.stringify(s.snapshot());
    expect(saved).not.toContain(ids[9]!);
    expect(saved).toContain(ids[9]!.slice(0, 16));
    const restored = MemorySeenStore.restore(JSON.parse(saved), 3, 3);
    expect(ids.map((id) => restored.has(id))).toEqual([...Array(7).fill(false), true, true, true]);
    restored.add(randomId(), 2000);
    restored.prune(1500);
    expect(restored.has(ids[7]!)).toBe(false);
  });

  it('reads what older versions saved', () => {
    const ids = Array.from({ length: 5 }, randomId);
    const wraps = Array.from({ length: 5 }, randomId).map((w) => w.slice(0, 16));
    const s = MemorySeenStore.restore({ sync: 1_800_000_000, ids, wraps, relays: { [RELAY]: 1_800_000_100 } });
    expect(ids.every((id) => s.has(id))).toBe(true);
    expect(wraps.every((w) => s.hasWrap(w + '0'.repeat(48)))).toBe(true);
    expect(s.syncedUntil(RELAY)).toBe(1_800_000_100);
    expect(s.syncedUntil('wss://other.example')).toBe(1_800_000_000);
  });

  it('keeps junk apart, so a flood of it cannot push out the wraps already handled', async () => {
    const { pool, bob, bobPub, sender, nowS } = world();
    // By count it keeps (at least) 30 wraps here: the flood alone would fill that.
    const seen = new MemorySeenStore(20, 30);
    const t = bob(seen);
    await t.start();
    await sender().send(bobPub, chat('echt'));
    const real = pool.events[0]!.event;
    expect(seen.hasWrap(real.id)).toBe(true);
    for (let i = 0; i < 100; i++) await pool.publish([RELAY], junkFor(bobPub, nowS() - i));
    expect(seen.hasWrap(real.id)).toBe(true);
    // The junk is remembered too, so it is opened only once.
    expect(seen.hasWrap(pool.events.at(-1)!.event.id)).toBe(true);
  });

  it("opens a stranger's or an unreadable message once, not again on every catch-up", async () => {
    const known = new Set<string>();
    const { pool, bob, bobPub, sender, nowS, tick } = world((from) => known.has(from));
    const seen = new MemorySeenStore();
    const errors: unknown[] = [];
    const t = bob(seen, (e) => errors.push(e));
    const open = vi.spyOn(t as unknown as { open: (...a: unknown[]) => unknown }, 'open');
    const inbox: IncomingMessage[] = [];
    t.onMessage((m) => inbox.push(m));
    await t.start();

    const strangerKey = generateSecretKey();
    const stranger = sender(strangerKey);
    for (let i = 0; i < 60; i++) await stranger.send(bobPub, chat(`spam ${i}`));
    // A contact on a newer version sends something this one cannot read yet.
    const aliceKey = generateSecretKey();
    known.add(getPublicKey(aliceKey));
    await pool.publish([RELAY], wrapOf(aliceKey, bobPub, JSON.stringify({ v: 1, type: 'new.kind', id: 'abcdefgh', sentAt: nowS() * 1000 }), nowS()));
    for (let i = 0; i < 5; i++) await pool.publish([RELAY], junkFor(bobPub, nowS() - i));
    expect(open).toHaveBeenCalledTimes(66);
    expect(inbox).toHaveLength(0);

    // A reconnect: the same window comes again.
    open.mockClear();
    await t.stop();
    tick(60_000);
    await t.start();
    expect(open).not.toHaveBeenCalled();
    expect(inbox).toHaveLength(0);
  });

  it('still lets through someone who becomes known later, also past what waits in memory', async () => {
    const known = new Set<string>();
    const { bob, bobPub, sender, tick } = world((from) => known.has(from));
    const t = bob(new MemorySeenStore());
    const inbox: IncomingMessage[] = [];
    t.onMessage((m) => inbox.push(m));
    await t.start();
    const strangerKey = generateSecretKey();
    for (let i = 0; i < 60; i++) await sender(strangerKey).send(bobPub, chat(`hallo ${i}`));
    expect(inbox).toHaveLength(0);

    // My other device's sync tells this one about them.
    known.add(getPublicKey(strangerKey));
    t.redeliverRefused();
    expect(inbox.length).toBeGreaterThan(0);
    // What no longer fitted in memory comes with the next catch-up.
    await t.stop();
    tick(60_000);
    await t.start();
    expect(new Set(textsOf(inbox)).size).toBe(60);
    expect(inbox).toHaveLength(60);
  });

  it('backdates wraps by at most an hour, and asks relays to drop each one after the same time', async () => {
    const { pool, bobPub, sender, nowS } = world();
    const alice = sender();
    const messages: AppMessage[] = [
      chat('hallo'),
      composeMessage({ type: 'sos.start', sosId: 'sos-id-0001', others: [] }),
      composeMessage({ type: 'live.update', shareId: 'share-0001', point: { lat: 52, lon: 13, accuracyM: 5 } }),
    ];
    for (let i = 0; i < 60; i++) await alice.send(bobPub, messages[i % 3]!, { ttlSeconds: 600 + i * 3600 });
    const created = pool.events.map(({ event }) => event.created_at);
    expect(Math.min(...created)).toBeGreaterThanOrEqual(nowS() - 3600);
    expect(Math.max(...created)).toBeLessThanOrEqual(nowS());
    const lifetimes = new Set(pool.events.map(({ event }) => Number(event.tags.find((x) => x[0] === 'expiration')![1]) - event.created_at));
    expect(lifetimes).toEqual(new Set([MAX_AGE + 3600]));
  });

  it('after a reconnect asks only for the last couple of hours', async () => {
    const filters: number[] = [];
    let feed: FeedHandlers | undefined;
    const pool: RelayPool = {
      publish: async () => {},
      subscribe: (_relays, handlers) => {
        feed = handlers;
        filters.push(handlers.filter(RELAY).since!);
        return { close: () => {} };
      },
      close: () => {},
    };
    const clock = 1_800_000_000_000;
    const seen = new MemorySeenStore();
    const t = new NostrTransport({ secretKey: generateSecretKey(), ownRelays: [RELAY], relaysFor: () => [], pool, now: () => clock, seen });
    await t.start();
    feed!.onSynced!(RELAY);
    await t.stop();
    await t.start();
    expect(filters.at(-1)).toBe(clock / 1000 - 60 - 2 * 3600);
  });
});
