import { composeMessage, createInitialState, SocialNode, type AppMessage, type Contact, type NodeState } from '@heyda/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { MemorySeenStore, NostrTransport } from './nostr-transport';
import { MemoryRelayPool } from './pool';

/**
 * Regression tests: a contact's message the node cannot take yet (a group text before its roster,
 * an SOS update before the SOS) shared one small in-memory list with strangers' messages. Anyone
 * who knows my public key pushed it out with 200 messages from throwaway keys, and a restart lost
 * it too. Each test first reproduced the message never showing.
 */

const R = 'wss://relay.example';
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function world() {
  let pool = new MemoryRelayPool();
  const [lisaK, maxK, miaK] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
  const [LISA, MAX, MIA] = [lisaK, maxK, miaK].map((k) => getPublicKey(k)) as [string, string, string];
  const raw = (k: Uint8Array) => new NostrTransport({ secretKey: k, ownRelays: [R], relaysFor: () => [R], pool });
  const contact = (key: string, name: string): Contact => ({ key, name, relays: [R], addedAt: 1, verified: false, updatedAt: 1 });
  const initial: NodeState = {
    ...createInitialState({ key: MAX, name: 'Max', relays: [R], deviceId: 'dev-max-0001', deviceName: 'Max' }),
    contacts: [contact(LISA, 'Lisa'), contact(MIA, 'Mia')],
  };
  const chats: string[] = [];
  let node!: SocialNode;
  let transport!: NostrTransport;
  const run = async (state: NodeState, seen: MemorySeenStore) => {
    transport = new NostrTransport({ secretKey: maxK, ownRelays: [R], relaysFor: () => [R], pool, seen, accept: (f, m) => node.judgeMessage(f, m) });
    node = new SocialNode({ transport, initialState: state, syncDelayMs: 0 });
    node.on((e) => e.type === 'chat' && chats.push(String(e.entry.text)));
    await node.start();
    await settle();
  };
  const groupId = 'grp-familie-1';
  const roster = composeMessage({
    type: 'group.update',
    groupId,
    name: 'Familie',
    owner: LISA,
    version: 1,
    members: [
      { key: LISA, name: 'Lisa' },
      { key: MAX, name: 'Max' },
      { key: MIA, name: 'Mia' },
    ],
  } as AppMessage);
  const flood = async (n: number) => {
    for (let i = 0; i < n; i++) await raw(generateSecretKey()).send(MAX, composeMessage({ type: 'chat.text', text: `spam ${i}` }));
    await settle();
  };
  return {
    LISA,
    MAX,
    MIA,
    lisa: () => raw(lisaK),
    mia: () => raw(miaK),
    raw,
    initial,
    chats,
    run,
    flood,
    roster,
    groupId,
    node: () => node,
    transport: () => transport,
    /** A relay that kept nothing from before, as after a catch-up window passed. */
    newRelay: () => (pool = new MemoryRelayPool()),
  };
}

describe('a contact message held until the app can take it', () => {
  it('is not pushed out by a stranger flood, and shows once the roster is in', async () => {
    const w = world();
    await w.run(w.initial, new MemorySeenStore());
    await w.mia().send(w.MAX, composeMessage({ type: 'group.text', groupId: w.groupId, text: 'Hallo Familie' }));
    await settle();
    await w.flood(210);
    await w.lisa().send(w.MAX, w.roster);
    await settle();
    expect(w.node().getState().groups.map((g) => g.name)).toEqual(['Familie']);
    expect(w.chats).toEqual(['Hallo Familie']);
  }, 30_000);

  it('survives a restart through the saved store, and is shown once only', async () => {
    const w = world();
    const seen = new MemorySeenStore();
    await w.run(w.initial, seen);
    await w.mia().send(w.MAX, composeMessage({ type: 'group.text', groupId: w.groupId, text: 'Hallo Familie' }));
    await settle();
    await w.node().stop();
    // The app restarts from what it saved; the relays no longer hand the message over.
    const restored = MemorySeenStore.restore(JSON.parse(JSON.stringify(seen.snapshot())));
    w.newRelay();
    await w.run(w.node().getState(), restored);
    await w.lisa().send(w.MAX, w.roster);
    await settle();
    expect(w.chats).toEqual(['Hallo Familie']);
    const again = MemorySeenStore.restore(JSON.parse(JSON.stringify(restored.snapshot())));
    await w.node().stop();
    await w.run(w.node().getState(), again);
    await settle();
    expect(w.chats).toEqual(['Hallo Familie']);
    expect(again.snapshot().held ?? []).toEqual([]);
  });

  it('keeps strangers out of the saved store, and one contact cannot push out what waits for another', async () => {
    const w = world();
    const seen = new MemorySeenStore();
    await w.run(w.initial, seen);
    await w.mia().send(w.MAX, composeMessage({ type: 'group.text', groupId: w.groupId, text: 'Hallo Familie' }));
    await settle();
    // Lisa (a contact) sends a lot for a group nobody ever tells me about.
    const lisa = w.lisa();
    for (let i = 0; i < 120; i++) await lisa.send(w.MAX, composeMessage({ type: 'group.text', groupId: 'grp-gibtsnicht', text: `x${i}` }));
    await w.flood(30);
    const held = seen.snapshot().held ?? [];
    expect(held.filter((h) => h.from === w.MIA)).toHaveLength(1);
    expect(held.filter((h) => h.from === w.LISA).length).toBeLessThanOrEqual(50);
    expect(held.every((h) => h.from === w.MIA || h.from === w.LISA)).toBe(true);
    await w.lisa().send(w.MAX, w.roster);
    await settle();
    expect(w.chats).toEqual(['Hallo Familie']);
  }, 30_000);

  it('keeps the newest of a sender over budget, also when they come in newest first as in a catch-up', () => {
    // Relays hand stored messages over newest first: an SOS's last positions come before its
    // start, and were the ones pushed out, so a helper saw an old position as the latest.
    const seen = new MemorySeenStore();
    const from = 'a'.repeat(64);
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    for (let i = 59; i >= 0; i--) {
      seen.hold({ id: hex(i), wrap: hex(1000 + i), wrapUntil: 2_000_000_000, keepUntil: 1_900_000_000 + i, from, content: `{"n":${i}}` });
    }
    const kept = seen.heldMessages().map((h) => h.keepUntil - 1_900_000_000);
    expect(kept.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 10));
    // The same after a restart.
    const back = MemorySeenStore.restore(JSON.parse(JSON.stringify(seen.snapshot())));
    expect(back.heldMessages().map((h) => h.keepUntil - 1_900_000_000).sort((a, b) => a - b)).toEqual(kept);
  });

  it('tells hold from refuse: a contact waiting for state is held, a stranger refused', async () => {
    const w = world();
    await w.run(w.initial, new MemorySeenStore());
    const stranger = getPublicKey(generateSecretKey());
    const text = composeMessage({ type: 'group.text', groupId: w.groupId, text: 'Hallo' });
    expect(w.node().judgeMessage(w.MIA, text)).toBe('hold');
    expect(w.node().judgeMessage(stranger, text)).toBe('refuse');
    expect(w.node().judgeMessage(w.MIA, composeMessage({ type: 'chat.text', text: 'Hi' }))).toBe('accept');
    expect(w.node().acceptsMessage(w.MIA, text)).toBe(false);
  });
});
