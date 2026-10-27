import { composeMessage, createInitialState, SocialNode, type IncomingMessage, type NodeState } from '@heyda/core';
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { APP_RUMOR_KIND, GIFT_WRAP_KIND, MemorySeenStore, NostrTransport } from './nostr-transport';
import { MemoryRelayPool, type FeedHandlers, type RelayPool } from './pool';

const RELAY_A = 'wss://relay-a.example';
const RELAY_B = 'wss://relay-b.example';

function setup() {
  // Real time: nostr-tools' createWrap dates wraps by the real clock, and the transport skips wraps
  // too old to hold a message younger than maxAge.
  let clock = Date.now();
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

  it('keeps working after the caller wipes the key array it passed in', async () => {
    const pool = new MemoryRelayPool();
    const aliceKey = generateSecretKey();
    const bobKey = generateSecretKey();
    const errors: unknown[] = [];
    const make = (key: Uint8Array, own: string, to: string) =>
      new NostrTransport({ secretKey: key, ownRelays: [own], relaysFor: () => [to], pool, onError: (e) => errors.push(e) });
    const alice = make(aliceKey, RELAY_A, RELAY_B);
    const bob = make(bobKey, RELAY_B, RELAY_A);
    // The app wipes its copy of the identity key right after building the transport.
    aliceKey.fill(0);
    bobKey.fill(0);
    const got: string[] = [];
    bob.onMessage((m) => got.push(`bob:${m.message.type}`));
    alice.onMessage((m) => got.push(`alice:${m.message.type}`));
    await bob.start();
    await alice.start();
    await alice.send(bob.selfKey, composeMessage({ type: 'sos.start', sosId: 'sos-id-0001', others: [] }));
    await bob.send(alice.selfKey, composeMessage({ type: 'sos.ack', sosId: 'sos-id-0001', owner: alice.selfKey }));
    expect(errors).toEqual([]);
    expect(got).toEqual(['bob:sos.start', 'alice:sos.ack']);

    // Once disposed, the key copy is gone and nothing can be sent with it any more.
    await alice.dispose();
    await expect(alice.send(bob.selfKey, composeMessage({ type: 'chat.text', text: 'x' }))).rejects.toThrow();
  });

  it('gives every wrap the same lifetime on relays, whatever the message and its TTL', async () => {
    const { pool, alice, bob } = setup();
    const sends: [string, number | undefined][] = [
      ['chat.text', 7 * 86_400],
      ['live.update', 3600],
      ['sos.start', 3 * 86_400],
      ['watch.start', 3 * 3600 + 17 * 60 + 6 * 3600],
      ['link.done', 900],
      ['ping', undefined],
    ];
    const bodies: Record<string, Parameters<typeof composeMessage>[0]> = {
      'chat.text': { type: 'chat.text', text: 'hallo' },
      'live.update': { type: 'live.update', shareId: 'share-0001', point: { lat: 52, lon: 13, accuracyM: 5 } },
      'sos.start': { type: 'sos.start', sosId: 'sos-id-0001', others: [] },
      'watch.start': { type: 'watch.start', watchId: 'watch-0001', label: 'Heimweg', dueAt: 1_800_011_820_000 },
      'link.done': { type: 'link.done', deviceId: 'device-phone', deviceName: 'Handy' },
      ping: { type: 'ping', kind: 'help-carry' },
    };
    for (const [type, ttl] of sends) await alice.send(bob.selfKey, composeMessage(bodies[type]!), ttl ? { ttlSeconds: ttl } : {});
    const lifetimes = pool.events.map(({ event }) => {
      const exp = event.tags.find((t) => t[0] === 'expiration');
      return exp ? Number(exp[1]) - event.created_at : undefined;
    });
    // Measured from the randomized created_at, so it reveals neither the kind of message nor when it
    // was sent: the 8 days a recipient takes a message, plus the hour of backdating.
    expect(new Set(lifetimes)).toEqual(new Set([8 * 86_400 + 3600]));
  });

  it('after a restart still finds wraps from a sender whose clock runs behind', async () => {
    const { pool, aliceKey, bobKey, now, tick } = setup();
    const seen = new MemorySeenStore();
    const make = () => new NostrTransport({ secretKey: bobKey, ownRelays: [RELAY_B], relaysFor: () => [], pool, now, seen });
    const first = make();
    await first.start();
    expect(seen.syncedUntil(RELAY_B)).toBe(Math.floor(now() / 1000) - 60);
    await first.stop();

    // Ten minutes later Alice writes. Her phone's clock is 45 minutes behind, and the wrap got the
    // full hour of backdating.
    tick(10 * 60_000);
    const aliceNow = Math.floor(now() / 1000) - 45 * 60;
    const content = JSON.stringify(composeMessage({ type: 'sos.start', sosId: 'sos-id-0001', others: [] }, aliceNow * 1000));
    const rumor = createRumor({ kind: APP_RUMOR_KIND, content, created_at: aliceNow }, aliceKey);
    const seal = createSeal(rumor, aliceKey, getPublicKey(bobKey));
    const oneTime = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: GIFT_WRAP_KIND,
        content: nip44Encrypt(JSON.stringify(seal), getConversationKey(oneTime, getPublicKey(bobKey))),
        created_at: aliceNow - 3600 + 1,
        tags: [['p', getPublicKey(bobKey)]],
      },
      oneTime,
    );
    await pool.publish([RELAY_B], wrap);

    tick(3600_000);
    const second = make();
    const got: string[] = [];
    second.onMessage((m) => got.push(m.message.type));
    await second.start();
    expect(got).toEqual(['sos.start']);
  });

  it('offers a message again once its sender became known', async () => {
    const { pool, aliceKey, bobKey, now } = setup();
    const known = new Set<string>();
    const bob = new NostrTransport({ secretKey: bobKey, ownRelays: [RELAY_B], relaysFor: () => [], pool, now, accept: (from) => known.has(from) });
    const alice = new NostrTransport({ secretKey: aliceKey, ownRelays: [RELAY_A], relaysFor: () => [RELAY_B], pool, now });
    const inbox: IncomingMessage[] = [];
    bob.onMessage((m) => inbox.push(m));
    await bob.start();
    await alice.send(bob.selfKey, composeMessage({ type: 'chat.text', text: 'Hi, hier ist Alice!' }));
    expect(inbox).toHaveLength(0);
    bob.redeliverRefused();
    expect(inbox).toHaveLength(0);

    // A moment later Bob's other device tells this one about Alice.
    known.add(alice.selfKey);
    bob.redeliverRefused();
    bob.redeliverRefused();
    expect(inbox.map((m) => m.message.type === 'chat.text' && m.message.text)).toEqual(['Hi, hier ist Alice!']);
  });

  it("a new contact's first message also reaches my other device that learns about them a moment later", async () => {
    const pool = new MemoryRelayPool();
    const lisaKey = generateSecretKey();
    const maxKey = generateSecretKey();
    const LISA = getPublicKey(lisaKey);
    const MAX = getPublicKey(maxKey);
    const transport = (key: Uint8Array) => {
      const t: NostrTransport = new NostrTransport({
        secretKey: key,
        ownRelays: [RELAY_A],
        relaysFor: () => [RELAY_A],
        pool,
        accept: (from, message) => nodes.get(t)!.acceptsMessage(from, message),
      });
      return t;
    };
    const nodes = new Map<NostrTransport, SocialNode>();
    const node = (key: Uint8Array, name: string, deviceId: string, other?: string) => {
      const t = transport(key);
      const initialState = {
        ...createInitialState({ key: getPublicKey(key), name, relays: [RELAY_A], deviceId, deviceName: deviceId }),
        devices: other ? [{ deviceId: other, name: other, linkedAt: 0 }] : [],
      };
      const n = new SocialNode({ transport: t, initialState, syncDelayMs: 0 });
      nodes.set(t, n);
      return n;
    };
    const phone = node(lisaKey, 'Lisa', 'dev-phone-01', 'dev-desk-001');
    const desk = node(lisaKey, 'Lisa', 'dev-desk-001', 'dev-phone-01');
    const max = node(maxKey, 'Max', 'dev-max-0001');
    for (const n of [phone, desk, max]) await n.start();
    const deskChats: string[] = [];
    desk.on((e) => e.type === 'chat' && deskChats.push(e.entry.text));
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    };

    // Max scans the QR code on Lisa's phone and writes right away.
    await max.acceptInvite(phone.createInvite());
    await settle();
    await max.sendChat(LISA, 'Hi Lisa, hier ist Max!');
    await settle();
    expect(desk.getState().contacts).toHaveLength(0);

    // The phone's settings sync reaches the desktop.
    await phone.flushSync();
    await settle();
    expect(desk.getState().contacts.map((c) => c.key)).toEqual([MAX]);
    expect(deskChats).toEqual(['Hi Lisa, hier ist Max!']);
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

  it('says when every own relay has handed over what it stored, so missed deadlines can be judged', async () => {
    let feed: FeedHandlers | undefined;
    const pool: RelayPool = {
      publish: async () => {},
      subscribe: (_relays, handlers) => {
        feed = handlers;
        return { close: () => {} };
      },
      close: () => {},
    };
    const t = new NostrTransport({ secretKey: generateSecretKey(), ownRelays: [RELAY_A, RELAY_B, RELAY_A], relaysFor: () => [], pool });
    await t.start();
    let done = false;
    void t.caughtUp().then(() => (done = true));
    const settle = () => new Promise((r) => setTimeout(r, 0));
    feed!.onSynced!(RELAY_A);
    feed!.onSynced!(RELAY_A);
    await settle();
    expect(done).toBe(false);
    feed!.onSynced!(RELAY_B);
    await settle();
    expect(done).toBe(true);
  });

  it('says when every own relay caught up again after a wake-up, not from what it said before', async () => {
    let feed: FeedHandlers | undefined;
    const pool: RelayPool = {
      publish: async () => {},
      subscribe: (_relays, handlers) => {
        feed = handlers;
        return { close: () => {} };
      },
      close: () => {},
    };
    const t = new NostrTransport({ secretKey: generateSecretKey(), ownRelays: [RELAY_A, RELAY_B], relaysFor: () => [], pool });
    await t.start();
    const settle = () => new Promise((r) => setTimeout(r, 0));
    feed!.onSynced!(RELAY_A);
    feed!.onSynced!(RELAY_B);
    await t.caughtUp();
    // The laptop slept; its timers fire on waking, before the connections are back.
    let again = false;
    void t.caughtUpAgain().then(() => (again = true));
    await settle();
    expect(again).toBe(false);
    feed!.onSynced!(RELAY_B);
    await settle();
    expect(again).toBe(false);
    feed!.onSynced!(RELAY_A);
    await settle();
    expect(again).toBe(true);
    // Nothing to wait for once stopped: nothing more arrives.
    let stopped = false;
    void t.caughtUpAgain().then(() => (stopped = true));
    await t.stop();
    await settle();
    expect(stopped).toBe(true);
  });
});
