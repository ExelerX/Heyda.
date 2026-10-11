import { composeMessage, createInitialState, SocialNode, type IncomingMessage, type NodeState } from '@heyda/core';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { APP_RUMOR_KIND, GIFT_WRAP_KIND, MemorySeenStore, NostrTransport } from './nostr-transport';
import { MemoryRelayPool } from './pool';

const RELAY_A = 'wss://relay-a.example';
const RELAY_B = 'wss://relay-b.example';

function setup() {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const pool = new MemoryRelayPool();
  const aliceKey = generateSecretKey();
  const bobKey = generateSecretKey();
  const relaysByKey = new Map([
    [getPublicKey(aliceKey), [RELAY_A]],
    [getPublicKey(bobKey), [RELAY_B]],
  ]);
  const make = (secretKey: Uint8Array, own: string) =>
    new NostrTransport({ secretKey, ownRelays: [own], relaysFor: (k) => relaysByKey.get(k) ?? [], pool, now });
  const alice = make(aliceKey, RELAY_A);
  const bob = make(bobKey, RELAY_B);
  const inbox: IncomingMessage[] = [];
  bob.onMessage((m) => inbox.push(m));
  return { pool, alice, bob, aliceKey, bobKey, inbox, tick: (ms: number) => (clock += ms), now };
}

describe('NostrTransport', () => {
  it('delivers an encrypted message and authenticates the sender', async () => {
    const { pool, alice, bob, inbox } = setup();
    await bob.start();
    const msg = composeMessage({ type: 'chat.text', text: 'Bin gleich da!' });
    await alice.send(bob.selfKey, msg, { ttlSeconds: 3600 });

    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.from).toBe(alice.selfKey);
    expect(inbox[0]!.message).toEqual(msg);

    // What the relay stores reveals neither the sender nor the text.
    const stored = pool.events[0]!;
    expect(stored.relays).toEqual([RELAY_B]);
    expect(stored.event.kind).toBe(GIFT_WRAP_KIND);
    expect(stored.event.pubkey).not.toBe(alice.selfKey);
    expect(stored.event.content).not.toContain('gleich');
    expect(JSON.stringify(stored.event)).not.toContain(alice.selfKey);
    expect(stored.event.tags).toContainEqual(['p', bob.selfKey]);
    expect(stored.event.tags.some((t) => t[0] === 'expiration')).toBe(true);
  });

  it('picks up messages that arrived while offline', async () => {
    const { alice, bob, inbox } = setup();
    await alice.send(bob.selfKey, composeMessage({ type: 'ping', kind: 'help-carry' }));
    expect(inbox).toHaveLength(0);
    await bob.start();
    expect(inbox.map((m) => m.message.type)).toEqual(['ping']);
  });

  it('drops duplicates delivered by several relays', async () => {
    const { pool, alice, bob, inbox } = setup();
    await bob.start();
    await alice.send(bob.selfKey, composeMessage({ type: 'chat.text', text: 'eins' }));
    const wrap = pool.events[0]!.event;
    await pool.publish([RELAY_B], wrap);
    expect(inbox).toHaveLength(1);
  });

  it('drops replays of old messages', async () => {
    const { pool, alice, bob, inbox, tick } = setup();
    await alice.send(bob.selfKey, composeMessage({ type: 'chat.text', text: 'alt' }));
    tick(9 * 24 * 3600 * 1000);
    await bob.start();
    expect(pool.events).toHaveLength(1);
    expect(inbox).toHaveLength(0);
  });

  it('rejects a seal whose inner author was forged', async () => {
    const { pool, bob, inbox, aliceKey } = setup();
    await bob.start();
    const mallory = generateSecretKey();
    // Mallory signs the seal but claims Alice wrote the rumor.
    const rumor = createRumor(
      { kind: APP_RUMOR_KIND, content: JSON.stringify(composeMessage({ type: 'chat.text', text: 'fake' })) },
      aliceKey,
    );
    const seal = createSeal(rumor, mallory, bob.selfKey);
    await pool.publish([RELAY_B], createWrap(seal, bob.selfKey));
    expect(inbox).toHaveLength(0);
  });

  it('ignores tampered wraps and foreign event kinds', async () => {
    const { pool, alice, bob, inbox } = setup();
    await bob.start();
    await alice.send(bob.selfKey, composeMessage({ type: 'chat.text', text: 'x' }));
    const good = pool.events[0]!.event;
    await pool.publish([RELAY_B], { ...good, id: 'f'.repeat(64), content: good.content.slice(0, -4) + 'AAAA' });
    const junk = finalizeEvent({ kind: GIFT_WRAP_KIND, content: 'nope', tags: [['p', bob.selfKey]], created_at: 1 }, generateSecretKey());
    await pool.publish([RELAY_B], junk);
    expect(inbox).toHaveLength(1);
  });

  it('remembers processed messages across restarts', async () => {
    const { pool, alice, now, bobKey } = setup();
    const seen = new MemorySeenStore();
    const make = () =>
      new NostrTransport({ secretKey: bobKey, ownRelays: [RELAY_B], relaysFor: () => [], pool, now, seen });
    const first = make();
    const got: string[] = [];
    first.onMessage((m) => got.push(m.message.id));
    await first.start();
    await alice.send(first.selfKey, composeMessage({ type: 'chat.text', text: 'einmal' }));
    await first.stop();

    const restored = MemorySeenStore.restore(seen.snapshot());
    const second = new NostrTransport({ secretKey: bobKey, ownRelays: [RELAY_B], relaysFor: () => [], pool, now, seen: restored });
    second.onMessage((m) => got.push(m.message.id));
    await second.start();
    expect(got).toHaveLength(1);
  });

  it('runs two full app nodes over it', async () => {
    const { alice, bob } = setup();
    const state = (key: string, name: string, relay: string): NodeState =>
      createInitialState({ key, name, relays: [relay], deviceId: `device-${name}`, deviceName: name });
    const a = new SocialNode({ transport: alice, initialState: state(alice.selfKey, 'Alice', RELAY_A) });
    const b = new SocialNode({ transport: bob, initialState: state(bob.selfKey, 'Bob', RELAY_B) });
    await a.start();
    await b.start();
    await a.acceptInvite(b.createInvite());
    await new Promise((r) => setTimeout(r, 0));
    expect(b.getState().contacts.map((c) => c.name)).toEqual(['Alice']);
  });

  it('reaches every device of one account, and can publish to explicit relays', async () => {
    const pool = new MemoryRelayPool();
    const key = generateSecretKey();
    const phone = new NostrTransport({ secretKey: key, ownRelays: [RELAY_A], relaysFor: () => [RELAY_A], pool });
    const desktop = new NostrTransport({ secretKey: key, ownRelays: [RELAY_A], relaysFor: () => [RELAY_A], pool });
    const got: string[] = [];
    desktop.onMessage((m) => got.push(m.message.id));
    await phone.start();
    await desktop.start();
    const note = composeMessage({ type: 'link.done', deviceId: 'device-phone', deviceName: 'Handy' });
    await phone.send(phone.selfKey, note);
    expect(got).toEqual([note.id]);

    await phone.send(getPublicKey(generateSecretKey()), composeMessage({ type: 'chat.text', text: 'x' }), { relays: [RELAY_B] });
    expect(pool.events.at(-1)?.relays).toEqual([RELAY_B]);
  });
});
