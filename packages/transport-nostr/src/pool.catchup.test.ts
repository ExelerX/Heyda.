import { composeMessage, type IncomingMessage } from '@heyda/core';
import { schnorr } from '@noble/curves/secp256k1.js';
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_RUMOR_KIND, GIFT_WRAP_KIND, MemorySeenStore, NostrTransport } from './nostr-transport';
import { SimpleRelayPool, type SimpleRelayPoolOptions } from './pool';
import { FakeRelayNetwork, until } from './test/fake-relay';

/** Regression tests for the cost and the end of a catch-up, against a fake NIP-01 relay. */

const A = 'wss://relay-a.example';
const FAST: SimpleRelayPoolOptions = { reconnectDelaysMs: [20, 40], probeEveryMs: 100, timeoutMs: 300 };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  vi.restoreAllMocks();
});

function world(cap: number, poolOptions: SimpleRelayPoolOptions = {}) {
  const net = new FakeRelayNetwork();
  const relay = net.add(A, cap);
  useWebSocketImplementation(net.WebSocket);
  const transport = (key: Uint8Array, seen?: MemorySeenStore) => {
    const pool = new SimpleRelayPool({ ...FAST, ...poolOptions });
    const t = new NostrTransport({ secretKey: key, ownRelays: [A], relaysFor: () => [A], pool, seen });
    cleanup.push(
      () => t.stop(),
      () => pool.close(),
    );
    return t;
  };
  return { relay, transport };
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wrapOf(senderKey: Uint8Array, recipient: string, text: string, createdAt: number): NostrEvent {
  const content = JSON.stringify(composeMessage({ type: 'chat.text', text }, createdAt * 1000));
  const seal = createSeal(createRumor({ kind: APP_RUMOR_KIND, content, created_at: createdAt }, senderKey), senderKey, recipient);
  const oneTime = generateSecretKey();
  return finalizeEvent(
    { kind: GIFT_WRAP_KIND, content: nip44Encrypt(JSON.stringify(seal), getConversationKey(oneTime, recipient)), created_at: createdAt, tags: [['p', recipient]] },
    oneTime,
  );
}

describe('catch-up over real relay connections', () => {
  it('drops copies of what was handled without checking their signatures, and still pages past them', async () => {
    const { relay, transport } = world(10);
    const bobKey = generateSecretKey();
    const bobPub = getPublicKey(bobKey);
    const seen = new MemorySeenStore();
    const alice = transport(generateSecretKey());
    const first = transport(bobKey, seen);
    const inbox: IncomingMessage[] = [];
    first.onMessage((m) => inbox.push(m));
    await first.start();
    await until(() => seen.syncedUntil(A) > 0, 2000, 'first catch-up');
    for (let i = 0; i < 30; i++) await alice.send(bobPub, composeMessage({ type: 'chat.text', text: `vorher ${i}` }));
    await until(() => inbox.length === 30, 5000, 'first messages');
    await first.stop();
    const known = new Set(relay.events.map((e) => e.id));

    // While Bob is away, Carol writes. Her wraps are older than all the others, so the
    // catch-up reaches them only after three full pages of copies.
    const carolKey = generateSecretKey();
    const oldest = Math.min(...relay.events.map((e) => e.created_at));
    const fresh = Array.from({ length: 5 }, (_, i) => wrapOf(carolKey, bobPub, `neu ${i}`, oldest - 60 - i));
    for (const w of fresh) relay.store(w);

    const verify = vi.spyOn(schnorr, 'verify');
    const second = transport(bobKey, seen);
    const again: IncomingMessage[] = [];
    second.onMessage((m) => again.push(m));
    await second.start();
    await until(() => again.length === 5, 5000, "Carol's messages");
    const checked = verify.mock.calls.map((args) => hex(args[1] as Uint8Array));
    expect(checked.filter((id) => known.has(id))).toEqual([]);
    // Each new wrap is checked once, not once by the pool and again by the transport.
    for (const w of fresh) expect(checked.filter((id) => id === w.id)).toHaveLength(1);
    expect(again.map((m) => m.message.type === 'chat.text' && m.message.text).sort()).toEqual(fresh.map((_, i) => `neu ${i}`).sort());
  }, 20_000);

  it('does not count a catch-up cut off at the page limit as complete', async () => {
    const { transport } = world(10, { pageSize: 10, maxPages: 2 });
    const bobKey = generateSecretKey();
    const bobPub = getPublicKey(bobKey);
    const alice = transport(generateSecretKey());
    for (let i = 0; i < 50; i++) await alice.send(bobPub, composeMessage({ type: 'chat.text', text: `${i}` }));

    const seen = new MemorySeenStore();
    const bob = transport(bobKey, seen);
    const inbox: IncomingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    let caughtUp = false;
    await bob.start();
    void bob.caughtUp().then(() => (caughtUp = true));
    // The first page and two more (a page may repeat a wrap or two sharing its oldest second).
    await until(() => inbox.length >= 25, 5000, 'three pages');
    // Several probes later: the connection is fine, but older wraps were never asked for.
    await sleep(500);
    expect(inbox.length).toBeLessThanOrEqual(30);
    expect(seen.syncedUntil(A)).toBe(0);
    expect(caughtUp).toBe(false);
  }, 10_000);
});
