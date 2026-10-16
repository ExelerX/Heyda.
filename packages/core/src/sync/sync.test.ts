import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, type BackupContents } from '../backup/backup';
import { composeMessage } from '../protocol/compose';
import type { MessageOf } from '../protocol/messages';
import { createInitialState, type NodeState } from '../state';
import { buildSyncDoc, mergeSyncDoc, parseSyncDoc } from './doc';
import { decodeLinkInvite, encodeLinkInvite, linkCode } from './link';
import { chunkPayload, Reassembler } from './xfer';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function base(): NodeState {
  return createInitialState({ key: A, name: 'Lisa', relays: ['wss://r.example'], deviceId: 'device-one', deviceName: 'Handy' });
}

describe('xfer', () => {
  it('splits and reassembles a large payload in any order', () => {
    const payload = { text: 'x'.repeat(30_000), n: [1, 2, 3] };
    const chunks = chunkPayload('xfer-test-01', 'sync', payload);
    expect(chunks.length).toBe(4);
    const r = new Reassembler();
    const msgs = chunks.map((c) => composeMessage(c, 0) as MessageOf<'xfer.chunk'>).reverse();
    const results = msgs.map((m) => r.add(A, m, 0));
    expect(results.slice(0, -1).every((x) => x === undefined)).toBe(true);
    expect(results.at(-1)).toEqual(payload);
  });

  it('keeps senders apart and ignores contradicting chunks', () => {
    const chunks = chunkPayload('xfer-test-02', 'sync', { s: 'y'.repeat(20_000) }).map(
      (c) => composeMessage(c, 0) as MessageOf<'xfer.chunk'>,
    );
    const r = new Reassembler();
    // Chunk 0 from A, chunk 1 from B: neither completes.
    expect(r.add(A, chunks[0]!, 0)).toBeUndefined();
    expect(r.add(B, chunks[1]!, 0)).toBeUndefined();
    expect(r.add(A, { ...chunks[1]!, purpose: 'link' }, 0)).toBeUndefined();
    expect(r.add(A, chunks[2]!, 0)).toBeUndefined();
  });

  it('forgets unfinished transfers after ten minutes', () => {
    const chunks = chunkPayload('xfer-test-03', 'sync', { s: 'z'.repeat(20_000) }).map(
      (c) => composeMessage(c, 0) as MessageOf<'xfer.chunk'>,
    );
    const r = new Reassembler();
    r.add(A, chunks[0]!, 0);
    r.add(A, chunks[1]!, 0);
    expect(r.add(A, chunks[2]!, 11 * 60_000)).toBeUndefined();
  });
});

describe('device link codes', () => {
  const invite = { tempKey: B, relays: ['wss://r.example'], nonce: 'abcdefghijklmnop', expiresAt: 10_000 };

  it('round-trips and shows the same 6-digit code on both sides', () => {
    const text = encodeLinkInvite(invite);
    const d = decodeLinkInvite(text, 0);
    expect(d).toEqual({ ok: true, invite });
    expect(linkCode(invite)).toMatch(/^\d{3} \d{3}$/);
    expect(linkCode({ ...invite, nonce: 'abcdefghijklmnoq' })).not.toBe(linkCode(invite));
  });

  it('rejects expired, foreign and damaged codes', () => {
    expect(decodeLinkInvite(encodeLinkInvite(invite), 10_000).ok).toBe(false);
    expect(decodeLinkInvite('heyda:1:abc', 0).ok).toBe(false);
    expect(decodeLinkInvite('heyda-link:1:%%%', 0).ok).toBe(false);
  });
});

describe('sync doc', () => {
  it('merges contacts by newest change and honours removals', () => {
    const mine = { ...base(), contacts: [{ key: B, name: 'Max', relays: [], addedAt: 1, verified: false, updatedAt: 5, nickname: 'Alt' }] };
    const theirs = buildSyncDoc({ ...mine, contacts: [{ ...mine.contacts[0]!, nickname: 'Neu', updatedAt: 9 }] });
    const patch = mergeSyncDoc(mine, theirs, 100);
    expect(patch.contacts?.[0]?.nickname).toBe('Neu');

    const removed = buildSyncDoc({ ...mine, contacts: [], removedContacts: [{ key: B, at: 10 }] });
    const after = mergeSyncDoc(mine, removed, 100);
    expect(after.contacts).toEqual([]);
    expect(after.removedContacts).toEqual([{ key: B, at: 10 }]);
  });

  it('takes plain fields only when they are newer', () => {
    const mine = { ...base(), sosMessage: 'mein', syncRev: { sosMessage: 50 } };
    expect(mergeSyncDoc(mine, buildSyncDoc({ ...mine, sosMessage: 'alt', syncRev: { sosMessage: 40 } }), 100).sosMessage).toBeUndefined();
    const newer = mergeSyncDoc(mine, buildSyncDoc({ ...mine, sosMessage: 'neu', syncRev: { sosMessage: 60 } }), 100);
    expect(newer.sosMessage).toBe('neu');
    expect(newer.syncRev?.sosMessage).toBe(60);
  });

  it('rejects malformed docs', () => {
    expect(parseSyncDoc({})).toBeUndefined();
    expect(parseSyncDoc({ ...buildSyncDoc(base()), contacts: [{ key: 'nope' }] })).toBeUndefined();
    expect(parseSyncDoc(JSON.parse(JSON.stringify(buildSyncDoc(base()))))).toBeDefined();
  });
});

describe('backup', () => {
  const contents: BackupContents = { format: 'heyda.backup', v: 1, createdAt: 1, identity: 'c'.repeat(64), data: { hello: 'welt' } };

  it('round-trips with the right password only', async () => {
    const file = await encryptBackup(contents, 'richtig-langes-passwort', { logN: 14 });
    expect(await decryptBackup(file, 'richtig-langes-passwort')).toEqual({ ok: true, contents });
    expect((await decryptBackup(file, 'falsches-passwort!!')).ok).toBe(false);
  });

  it('detects tampering with the header or the data', async () => {
    const file = await encryptBackup(contents, 'richtig-langes-passwort', { logN: 14 });
    const header = file.slice();
    header[10] = header[10]! ^ 1; // salt byte
    expect((await decryptBackup(header, 'richtig-langes-passwort')).ok).toBe(false);
    const body = file.slice();
    body[body.length - 1] = body[body.length - 1]! ^ 1;
    expect((await decryptBackup(body, 'richtig-langes-passwort')).ok).toBe(false);
  });

  it('refuses short passwords and absurd scrypt parameters', async () => {
    await expect(encryptBackup(contents, 'kurz')).rejects.toThrow();
    const file = await encryptBackup(contents, 'richtig-langes-passwort', { logN: 14 });
    const evil = file.slice();
    evil[4] = 30; // 2^30 iterations would need gigabytes
    const r = await decryptBackup(evil, 'richtig-langes-passwort');
    expect(r.ok).toBe(false);
    const slow = file.slice();
    slow[6] = 4; // more parallel rounds than any app version writes
    expect((await decryptBackup(slow, 'richtig-langes-passwort')).ok).toBe(false);
  });

  it('writes p = 3 and still opens older files written with p = 1', async () => {
    const file = await encryptBackup(contents, 'richtig-langes-passwort', { logN: 14 });
    expect([...file.slice(4, 7)]).toEqual([14, 8, 3]);

    // A file as the first builds wrote it: same layout, p = 1.
    const header = file.slice(0, 47);
    header[6] = 1;
    const key = await scryptAsync('richtig-langes-passwort', header.slice(7, 23), { N: 2 ** 14, r: 8, p: 1, dkLen: 32 });
    const sealed = xchacha20poly1305(key, header.slice(23, 47), header).encrypt(new TextEncoder().encode(JSON.stringify(contents)));
    const old = new Uint8Array(47 + sealed.length);
    old.set(header, 0);
    old.set(sealed, 47);
    expect(await decryptBackup(old, 'richtig-langes-passwort')).toEqual({ ok: true, contents });
  });
});
