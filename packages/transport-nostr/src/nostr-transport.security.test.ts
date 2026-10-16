import { composeMessage, type IncomingMessage } from '@heyda/core';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { APP_RUMOR_KIND, MemorySeenStore, NostrTransport } from './nostr-transport';
import { MemoryRelayPool } from './pool';

/** Regression tests for the security review of the transport. */

const RELAY = 'wss://relay.example';

function setup(opts: { seen?: MemorySeenStore; aliceSkewMs?: number; accept?: (from: string) => boolean } = {}) {
  let clock = 1_800_000_000_000;
  const pool = new MemoryRelayPool();
  const aliceKey = generateSecretKey();
  const bobKey = generateSecretKey();
  const alice = new NostrTransport({
    secretKey: aliceKey,
    ownRelays: [RELAY],
    relaysFor: () => [RELAY],
    pool,
    now: () => clock + (opts.aliceSkewMs ?? 0),
  });
  const bob = new NostrTransport({
    secretKey: bobKey,
    ownRelays: [RELAY],
    relaysFor: () => [RELAY],
    pool,
    now: () => clock,
    seen: opts.seen,
    ...(opts.accept ? { accept: (from: string) => opts.accept!(from) } : {}),
  });
  const inbox: IncomingMessage[] = [];
  bob.onMessage((m) => inbox.push(m));
  return { pool, alice, bob, aliceKey, bobKey, inbox, nowS: () => Math.floor(clock / 1000) };
}

describe('NostrTransport security', () => {
  it('delivers messages from a phone whose clock runs a quarter of an hour fast', async () => {
    const { alice, bob, inbox } = setup({ aliceSkewMs: 15 * 60_000 });
    await bob.start();
    await alice.send(bob.selfKey, composeMessage({ type: 'sos.start', sosId: 'sos-id-0001', others: [] }));
    expect(inbox.map((m) => m.message.type)).toEqual(['sos.start']);
  });

  it("keeps strangers' messages out of the processed list, so they cannot get old wraps replayed", async () => {
    const seen = new MemorySeenStore(20);
    const known = new Set<string>();
    const { pool, alice, bob, inbox, nowS } = setup({ seen, accept: (from) => known.has(from) });
    known.add(alice.selfKey);
    await bob.start();
    await alice.send(bob.selfKey, composeMessage({ type: 'chat.text', text: 'einmal' }));
    expect(inbox).toHaveLength(1);
    const original = pool.events[0]!.event;

    // A stranger who knows Bob's key floods him with valid wraps ...
    const stranger = generateSecretKey();
    for (let i = 0; i < 30; i++) {
      const content = JSON.stringify(composeMessage({ type: 'ping', kind: 'custom' }));
      const rumor = createRumor({ kind: APP_RUMOR_KIND, content, created_at: nowS() }, stranger);
      await pool.publish([RELAY], createWrap(createSeal(rumor, stranger, bob.selfKey), bob.selfKey));
    }
    // ... and then re-publishes Alice's old wrap, which anyone can fetch from public relays.
    await pool.publish([RELAY], original);
    expect(inbox.map((m) => m.from)).toEqual([alice.selfKey]);
  });

  it('drops rumors whose id is not their hash', async () => {
    const { pool, bob, inbox, aliceKey, nowS } = setup();
    await bob.start();
    const content = JSON.stringify(composeMessage({ type: 'chat.text', text: 'x' }));
    const honest = createRumor({ kind: APP_RUMOR_KIND, content, created_at: nowS() }, aliceKey);
    await pool.publish([RELAY], createWrap(createSeal(honest, aliceKey, bob.selfKey), bob.selfKey));
    expect(inbox.map((m) => m.from)).toEqual([getPublicKey(aliceKey)]);
    const forged = { ...createRumor({ kind: APP_RUMOR_KIND, content: JSON.stringify(composeMessage({ type: 'chat.text', text: 'y' })), created_at: nowS() }, aliceKey), id: 'f'.repeat(64) };
    await pool.publish([RELAY], createWrap(createSeal(forged, aliceKey, bob.selfKey), bob.selfKey));
    expect(inbox).toHaveLength(1);
  });
});
