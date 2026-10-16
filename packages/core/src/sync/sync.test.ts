import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, type BackupContents } from '../backup/backup';
import { composeMessage } from '../protocol/compose';
import type { MessageOf } from '../protocol/messages';
import { createInitialState, type NodeState } from '../state';
import { buildSyncDoc, mergeSyncDoc, parseSyncDoc } from './doc';
import { base64urlEncode } from '../util/base64url';
import { createLinkInvite, decodeLinkInvite, encodeLinkInvite, LINK_TTL_MS, linkCode, linkCommitment } from './link';
import { LinkReceiver } from './receiver';
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
  const secret = new Uint8Array(32).fill(9);
  const invite = { tempKey: B, relays: ['wss://r.example'], nonce: 'abcdefghijklmnop', expiresAt: 10_000, commit: linkCommitment(secret) };

  it('round-trips a v2 code that commits to the new device\'s secret', () => {
    const text = encodeLinkInvite(invite);
    expect(text.startsWith('heyda-link:2:')).toBe(true);
    expect(decodeLinkInvite(text, 0)).toEqual({ ok: true, invite });
    expect(invite.commit).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(linkCommitment(new Uint8Array(32).fill(8))).not.toBe(invite.commit);
  });

  it('creates invites whose commitment matches the returned secret', () => {
    const { invite: made, secret: s } = createLinkInvite({ tempKey: B, relays: ['wss://r.example'], now: 1000 });
    expect(s).toHaveLength(32);
    expect(made.commit).toBe(linkCommitment(s));
    expect(made.expiresAt).toBe(1000 + LINK_TTL_MS);
    expect(decodeLinkInvite(encodeLinkInvite(made), 1000).ok).toBe(true);
    expect(createLinkInvite({ tempKey: B, relays: ['wss://r.example'], now: 1000 }).invite.nonce).not.toBe(made.nonce);
  });

  it('rejects expired, foreign and damaged codes', () => {
    expect(decodeLinkInvite(encodeLinkInvite(invite), 10_000).ok).toBe(false);
    expect(decodeLinkInvite('heyda:1:abc', 0).ok).toBe(false);
    expect(decodeLinkInvite('heyda-link:2:%%%', 0).ok).toBe(false);
    // Without a commitment, or with one of the wrong length.
    const raw = (o: object) => 'heyda-link:2:' + base64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const fields = { t: B, r: ['wss://r.example'], n: 'abcdefghijklmnop', e: 10_000 };
    expect(decodeLinkInvite(raw(fields), 0).ok).toBe(false);
    expect(decodeLinkInvite(raw({ ...fields, c: 'A'.repeat(42) }), 0).ok).toBe(false);
    expect(decodeLinkInvite(raw({ ...fields, c: invite.commit }), 0).ok).toBe(true);
  });

  it('turns away codes from the old version with a friendly hint', () => {
    const old = 'heyda-link:1:' + base64urlEncode(new TextEncoder().encode(JSON.stringify({ t: B, r: ['wss://r.example'], n: 'abcdefghijklmnop', e: 10_000 })));
    expect(decodeLinkInvite(old, 0)).toEqual({ ok: false, error: 'Dieser Code ist von einer älteren Version. Aktualisiere Heyda. auf beiden Geräten.' });
  });

  it('derives the 6 digits from both random shares and both keys', () => {
    const input = { tempKey: B, nonce: 'abcdefghijklmnop', accountKey: A, rE: new Uint8Array(32).fill(1), rN: new Uint8Array(32).fill(2) };
    const code = linkCode(input);
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(linkCode({ ...input })).toBe(code);
    const variants = [
      { ...input, tempKey: A },
      { ...input, nonce: 'abcdefghijklmnoq' },
      { ...input, accountKey: B },
      { ...input, rE: new Uint8Array(32).fill(3) },
      { ...input, rN: new Uint8Array(32).fill(3) },
    ];
    for (const v of variants) expect(linkCode(v)).not.toBe(code);
  });

  it('an invite made by someone else cannot reproduce the digits without both secrets', () => {
    // The old attack: grind nonces for an own one-time key until the digits match. Now the
    // digits also depend on the existing device's key and on rE and rN, which nobody knows in
    // advance, so grinding the invite gets the attacker nowhere.
    const victim = { tempKey: B, nonce: 'abcdefghijklmnop', accountKey: A, rE: new Uint8Array(32).fill(4), rN: new Uint8Array(32).fill(5) };
    const target = linkCode(victim);
    const hits = Array.from({ length: 2000 }, (_, i) =>
      linkCode({ ...victim, tempKey: 'c'.repeat(64), nonce: `attacker-nonce-${String(i).padStart(4, '0')}`, rN: new Uint8Array(32).fill(6) }),
    ).filter((c) => c === target);
    expect(hits).toEqual([]);
  });
});

describe('link receiver', () => {
  const secret = new Uint8Array(32).fill(9);
  const invite = { tempKey: B, relays: ['wss://r.example'], nonce: 'abcdefghijklmnop', expiresAt: 10_000, commit: linkCommitment(secret) };
  const C = 'c'.repeat(64);
  const hello = (nonce = invite.nonce, rE = new Uint8Array(32).fill(1)) =>
    composeMessage({ type: 'link.hello', nonce, rE: base64urlEncode(rE), relays: ['wss://e.example'] }, 0);

  it('refuses a secret that does not open the commitment', () => {
    expect(() => new LinkReceiver(invite, new Uint8Array(32).fill(1), () => A)).toThrow();
  });

  it('answers only the first hello for its nonce, with the reveal and the code', () => {
    const r = new LinkReceiver(invite, secret, () => A);
    expect(r.handle({ from: C, message: hello('abcdefghijklmnoX'), receivedAt: 0 }, 0)).toBeUndefined();
    const step = r.handle({ from: A, message: hello(), receivedAt: 0 }, 0);
    expect(step).toEqual({
      type: 'reveal',
      to: A,
      relays: ['wss://e.example', 'wss://r.example'],
      code: linkCode({ tempKey: B, nonce: invite.nonce, accountKey: A, rE: new Uint8Array(32).fill(1), rN: secret }),
      message: { type: 'link.reveal', nonce: invite.nonce, rN: base64urlEncode(secret) },
    });
    // Later hellos, from anyone, change nothing.
    expect(r.handle({ from: C, message: hello(), receivedAt: 0 }, 0)).toBeUndefined();
    expect(r.handle({ from: A, message: hello(invite.nonce, new Uint8Array(32).fill(2)), receivedAt: 0 }, 0)).toBeUndefined();
    expect(r.peerKey).toBe(A);
  });

  it('ignores a hello after the code expired', () => {
    const r = new LinkReceiver(invite, secret, () => A);
    expect(r.handle({ from: A, message: hello(), receivedAt: 0 }, 10_001)).toBeUndefined();
    expect(r.peerKey).toBeUndefined();
  });

  it('takes the account only from the device it answered, after it answered', () => {
    const payload = (secretKey: string) => ({
      format: 'heyda.link',
      v: 2,
      nonce: invite.nonce,
      secretKey,
      relays: ['wss://r.example'],
      deviceId: 'device-one',
      deviceName: 'Handy',
      devices: [],
      doc: buildSyncDoc(base()),
    });
    const chunks = (secretKey: string) => chunkPayload(`xfer-${secretKey.slice(0, 8)}`, 'link', payload(secretKey)).map((c) => composeMessage(c, 0));
    const r = new LinkReceiver(invite, secret, (s) => (s === 'a1'.repeat(32) ? A : C));
    // Before any hello: nothing counts, even if the account belongs to the sender.
    for (const m of chunks('a1'.repeat(32))) expect(r.handle({ from: A, message: m, receivedAt: 0 }, 0)).toBeUndefined();
    r.handle({ from: A, message: hello(), receivedAt: 0 }, 0);
    // Someone else's own account, from someone else: ignored.
    for (const m of chunks('c1'.repeat(32))) expect(r.handle({ from: C, message: m, receivedAt: 0 }, 0)).toBeUndefined();
    // Old payload version: ignored.
    const v1 = chunkPayload('xfer-old-0001', 'link', { ...payload('a1'.repeat(32)), v: 1 }).map((c) => composeMessage(c, 0));
    for (const m of v1) expect(r.handle({ from: A, message: m, receivedAt: 0 }, 0)).toBeUndefined();
    const results = chunks('a1'.repeat(32)).map((m) => r.handle({ from: A, message: m, receivedAt: 0 }, 0));
    const last = results.at(-1);
    expect(last?.type).toBe('payload');
    expect(last?.type === 'payload' && last.payload.accountKey).toBe(A);
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
