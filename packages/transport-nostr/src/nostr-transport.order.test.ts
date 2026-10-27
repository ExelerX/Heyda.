import { composeMessage, createInitialState, SocialNode, type Contact, type NodeState } from '@heyda/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { MemorySeenStore, NostrTransport } from './nostr-transport';
import { MemoryRelayPool } from './pool';

/**
 * Regression test with the real transport: a catch-up hands over backdated wraps in any order, so
 * a contact's group message can come before the roster that makes them a member. It first
 * reproduced the message being lost for good: dropped by the node, but marked handled here.
 */

const RELAY = 'wss://relay.example';
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('a group message that comes before its roster', () => {
  it('shows once the roster is in, and not again after a restart', async () => {
    const pool = new MemoryRelayPool();
    const [lisaKey, maxKey, miaKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
    const [LISA, MAX, MIA] = [getPublicKey(lisaKey), getPublicKey(maxKey), getPublicKey(miaKey)];
    const raw = (key: Uint8Array) => new NostrTransport({ secretKey: key, ownRelays: [RELAY], relaysFor: () => [RELAY], pool });
    const contact = (key: string, name: string): Contact => ({ key, name, relays: [RELAY], addedAt: 1, verified: false, updatedAt: 1 });
    const initial: NodeState = {
      ...createInitialState({ key: MAX, name: 'Max', relays: [RELAY], deviceId: 'dev-max-0001', deviceName: 'Max' }),
      contacts: [contact(LISA, 'Lisa'), contact(MIA, 'Mia')],
    };
    const seen = new MemorySeenStore();
    let node!: SocialNode;
    const transport = () =>
      new NostrTransport({ secretKey: maxKey, ownRelays: [RELAY], relaysFor: () => [RELAY], pool, seen, accept: (from, m) => node.acceptsMessage(from, m) });
    const chats: string[] = [];
    const run = async (state: NodeState) => {
      node = new SocialNode({ transport: transport(), initialState: state, syncDelayMs: 0 });
      node.on((e) => e.type === 'chat' && chats.push(`${e.thread}: ${e.entry.text}`));
      await node.start();
      await settle();
    };

    const groupId = 'grp-familie-1';
    // Stored on the relay in this order, as a catch-up of backdated wraps can hand them over.
    await raw(miaKey).send(MAX, composeMessage({ type: 'group.text', groupId, text: 'Hallo Familie' }));
    await raw(lisaKey).send(
      MAX,
      composeMessage({
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
      }),
    );

    await run(initial);
    expect(node.getState().groups.map((g) => g.name)).toEqual(['Familie']);
    expect(chats).toEqual([`g:${groupId}: Hallo Familie`]);
    // A restart catches up again: handled once, so it does not show a second time.
    const saved = node.getState();
    await node.stop();
    await run(saved);
    expect(chats).toEqual([`g:${groupId}: Hallo Familie`]);
  });
});
