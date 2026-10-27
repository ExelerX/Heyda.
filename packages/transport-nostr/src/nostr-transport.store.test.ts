import { composeMessage, type IncomingMessage } from '@heyda/core';
import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { MemorySeenStore, NostrTransport } from './nostr-transport';
import { MemoryRelayPool } from './pool';

/**
 * Regression tests for saving the seen store apart from the app data: its handled ids reach about
 * 3 MB and were written with every change. The app now writes it at most every 30 s, and keeps
 * what changed since then (the journal) in the small app data it saves on every change. A crash
 * in between must never lose a message, and never hand one over twice.
 */

const R = 'wss://relay.example';
const chat = (text: string) => composeMessage({ type: 'chat.text', text });
const textsOf = (inbox: IncomingMessage[]) => inbox.map((m) => (m.message.type === 'chat.text' ? m.message.text : m.message.type));
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('the seen store journal', () => {
  it('holds what changed since the last full save, and forgets only what that save holds', () => {
    const seen = new MemorySeenStore();
    seen.add('a'.repeat(64), 100);
    seen.addWrap('b'.repeat(64), 100);
    const full = seen.snapshot();
    const mark = seen.journalMark();
    // Comes in while the full save is being written.
    seen.add('c'.repeat(64), 100);
    seen.addJunk('d'.repeat(64), 100);
    expect(seen.journal().messageIds?.map(([id]) => id[0])).toEqual(['a', 'c']);
    seen.saved(mark);
    const journal = seen.journal();
    expect(journal.messageIds?.map(([id]) => id[0])).toEqual(['c']);
    expect(journal.wrapIds).toEqual([]);
    expect(journal.junkIds?.map(([id]) => id[0])).toEqual(['d']);
    expect(seen.journalSize()).toBe(2);
    // Restored from both, it knows everything, and the journal entries still wait for a full save.
    const back = MemorySeenStore.restore(json(full));
    back.merge(json(journal));
    for (const id of ['a', 'c']) expect(back.has(id.repeat(64))).toBe(true);
    expect(back.hasWrap('b'.repeat(64)) && back.hasWrap('d'.repeat(64))).toBe(true);
    expect(back.journalSize()).toBe(2);
  });

  it('after a crash between full saves, delivers nothing twice and loses nothing', async () => {
    const pool = new MemoryRelayPool();
    let clock = Date.UTC(2026, 9, 10, 12);
    const now = () => clock;
    const bobKey = generateSecretKey();
    const alice = new NostrTransport({ secretKey: generateSecretKey(), ownRelays: [R], relaysFor: () => [R], pool, now });
    const make = (seen: MemorySeenStore) => new NostrTransport({ secretKey: bobKey, ownRelays: [R], relaysFor: () => [R], pool, now, seen });
    const seen = new MemorySeenStore();
    const phone = make(seen);
    const inbox: IncomingMessage[] = [];
    phone.onMessage((m) => inbox.push(m));
    await phone.start();
    for (let i = 0; i < 5; i++) {
      clock += 5_000;
      await alice.send(phone.selfKey, chat(`vorher ${i}`));
    }
    // The full save, 30 s apart from the next one.
    const full = json(seen.snapshot());
    seen.saved(seen.journalMark());
    for (let i = 0; i < 5; i++) {
      clock += 5_000;
      await alice.send(phone.selfKey, chat(`danach ${i}`));
    }
    // The app data saved with the last change holds the journal. Then the app crashes.
    const journal = json(seen.journal());
    expect(textsOf(inbox)).toHaveLength(10);

    // Sent while the app was down: it must still come.
    clock += 60_000;
    await alice.send(phone.selfKey, chat('während'));
    clock += 60_000;
    const restored = MemorySeenStore.restore(full);
    restored.merge(journal);
    const again: IncomingMessage[] = [];
    const next = make(restored);
    next.onMessage((m) => again.push(m));
    await next.start();
    expect(textsOf(again)).toEqual(['während']);

    // Without the journal the five after the full save would come twice: it is what prevents that.
    const without: IncomingMessage[] = [];
    const careless = make(MemorySeenStore.restore(full));
    careless.onMessage((m) => without.push(m));
    await careless.start();
    expect(textsOf(without).filter((t) => t.startsWith('danach'))).toHaveLength(5);
  });
});
