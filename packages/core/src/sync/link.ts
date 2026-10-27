import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { Bytes32, LinkNonce, RelayUrl } from '../protocol/messages';
import { base64urlDecode, base64urlEncode } from '../util/base64url';
import { randomId } from '../util/random';

/**
 * Linking a second device (e.g. the Windows app) to an existing account.
 *
 * The danger is a swapped code: someone who can replace the code the existing device scans
 * (e.g. code text pasted through a chat) would receive the whole account. The user rules
 * that out by comparing 6 digits on both screens. So that an attacker cannot simply search
 * for a code of his own that gives the same digits, both devices add a random share, and the
 * new device commits to its share before it sees the other one (commit, then reveal):
 *
 * 1. The new device N makes a one-time key pair `tk`, a nonce `n` and a secret `rN` (32 random
 *    bytes). It shows `heyda-link:2:` with `tk`, its relays, `n`, an expiry and the commitment
 *    `c = sha256("heyda-link-v2:commit:" || rN)`. No digits yet.
 * 2. The existing device E scans it and keeps one pending session. It picks `rE` (32 random
 *    bytes) and sends `link.hello {n, rE}` from its account key `X` to `tk`.
 * 3. N takes only the first hello for its nonce, remembers `X`, answers `link.reveal {n, rN}`
 *    and only now shows the digits. Later hellos are ignored, except the very same hello from
 *    `X` again (its answer may have been lost): that gets the same reveal, a few times at most.
 * 4. E accepts one reveal, only from `tk`, and checks it against `c`. A wrong one ends the session.
 * 5. Both show the first 8 bytes of `sha256("heyda-link-v2:sas:" tk ":" n ":" X ":" || rE || rN)`
 *    modulo 1,000,000 as 6 digits (`linkCode`).
 * 6. The user compares and confirms on both devices. Only after the "yes" on E does E send the
 *    account (identity key, contacts, settings) end-to-end encrypted to `tk`, in chunks (one
 *    transfer per session, so a retry fills in what was missing). N takes it only from `X`,
 *    only if the identity key belongs to `X` and only after the "yes" on N; then the person
 *    confirms it is their account.
 *
 * A man in the middle must fix his share before he learns the other side's: `rN` is committed
 * before E picks `rE`, and N reveals `rN` only after the attacker sent his hello. So each
 * attempt is one guess with a 1 in 1,000,000 chance, and N accepts only one hello per code, so
 * every further guess needs the person to start over on both devices. Hello and reveal travel
 * like all messages (encrypted, the sender's key checked by the transport); they are not
 * secret from the other side, only the order matters. Someone who sees the code and answers
 * it first can block it (the real device then never shows digits). He could also send his own
 * account to N, to read along with everything done there later; that is why N waits for the
 * "yes" on N as well: the real E shows no digits then, so an attentive person says no (and the
 * account he sent still has to pass "Ist das dein Konto?"). The digits protect only if the user
 * really compares them.
 *
 * E bounds the session by its own clock as well (`LINK_TTL_MS` after the scan), since `e` comes
 * from N's clock. Relay addresses in the code must be plain `wss://` addresses (`RelayUrl`):
 * E contacts them right after the scan, before anything was compared.
 */
export const LINK_PREFIX = 'heyda-link:2:';
export const LINK_TTL_MS = 10 * 60 * 1000;
/** Size of the random shares rE and rN. */
export const LINK_SECRET_BYTES = 32;

const LinkInviteSchema = z.strictObject({
  t: z.string().regex(/^[0-9a-f]{64}$/),
  r: z.array(RelayUrl).min(1).max(8),
  n: LinkNonce,
  e: z.number().int().positive(),
  c: Bytes32,
});

export interface LinkInvite {
  /** Throwaway public key of the new device. */
  tempKey: string;
  relays: string[];
  nonce: string;
  expiresAt: number;
  /** base64url of sha256("heyda-link-v2:commit:" || rN). */
  commit: string;
}

export function encodeLinkInvite(invite: LinkInvite): string {
  const payload = LinkInviteSchema.parse({ t: invite.tempKey, r: invite.relays, n: invite.nonce, e: invite.expiresAt, c: invite.commit });
  return LINK_PREFIX + base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

export type DecodeLinkResult = { ok: true; invite: LinkInvite } | { ok: false; error: string };

export function decodeLinkInvite(text: string, now: number): DecodeLinkResult {
  const trimmed = text.trim();
  if (trimmed.startsWith('heyda-link:1:')) {
    return { ok: false, error: 'Dieser Code ist von einer älteren Version. Aktualisiere Heyda. auf beiden Geräten.' };
  }
  if (!trimmed.startsWith(LINK_PREFIX) && /^heyda-link:\d+:/.test(trimmed)) {
    return { ok: false, error: 'Dieser Code ist von einer anderen Version. Aktualisiere Heyda. auf beiden Geräten.' };
  }
  if (!trimmed.startsWith(LINK_PREFIX) || trimmed.length > 2000) return { ok: false, error: 'Kein Geräte-Code von Heyda.' };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(base64urlDecode(trimmed.slice(LINK_PREFIX.length))));
  } catch {
    return { ok: false, error: 'Der Code ist beschädigt.' };
  }
  const p = LinkInviteSchema.safeParse(json);
  if (!p.success) return { ok: false, error: 'Der Code ist beschädigt.' };
  // `e` comes from the new device's clock: if it runs late, every code looks expired here.
  if (p.data.e <= now) {
    return { ok: false, error: 'Der Code ist abgelaufen. Lass einen neuen anzeigen. Passiert das immer wieder, prüfe die Uhrzeit auf beiden Geräten.' };
  }
  return { ok: true, invite: { tempKey: p.data.t, relays: p.data.r, nonce: p.data.n, expiresAt: p.data.e, commit: p.data.c } };
}

/** 32 bytes from the platform CSPRNG. Wipe them (`fill(0)`) once they are no longer needed. */
export function randomLinkSecret(): Uint8Array {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) throw new Error('crypto.getRandomValues is not available');
  return cryptoObj.getRandomValues(new Uint8Array(LINK_SECRET_BYTES));
}

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** The commitment a device code carries: base64url(sha256("heyda-link-v2:commit:" || rN)). */
export function linkCommitment(secret: Uint8Array): string {
  if (secret.length !== LINK_SECRET_BYTES) throw new RangeError('link secret must be 32 bytes');
  const data = concat(enc.encode('heyda-link-v2:commit:'), secret);
  const digest = base64urlEncode(sha256(data));
  data.fill(0);
  return digest;
}

/** A fresh code for the new device, plus its secret `rN` (kept only on that device). */
export function createLinkInvite(opts: { tempKey: string; relays: string[]; now: number }): { invite: LinkInvite; secret: Uint8Array } {
  const secret = randomLinkSecret();
  const invite: LinkInvite = {
    tempKey: opts.tempKey,
    relays: opts.relays,
    nonce: randomId(24),
    expiresAt: opts.now + LINK_TTL_MS,
    commit: linkCommitment(secret),
  };
  return { invite, secret };
}

export interface LinkCodeInput {
  /** One-time key of the new device. */
  tempKey: string;
  nonce: string;
  /** Account key of the existing device (the sender of the hello). */
  accountKey: string;
  /** Random share of the existing device. */
  rE: Uint8Array;
  /** Random share of the new device, committed to in the code. */
  rN: Uint8Array;
}

/**
 * The 6 digits both screens show, e.g. "482 913". Keys are fixed-length hex and the nonce has
 * no ":", so the input reads only one way.
 */
export function linkCode(input: LinkCodeInput): string {
  if (input.rE.length !== LINK_SECRET_BYTES || input.rN.length !== LINK_SECRET_BYTES) throw new RangeError('link secret must be 32 bytes');
  const data = concat(enc.encode(`heyda-link-v2:sas:${input.tempKey}:${input.nonce}:${input.accountKey}:`), input.rE, input.rN);
  const d = sha256(data);
  data.fill(0);
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(d[i]!);
  // 2^64 is so much larger than 10^6 that the modulo bias is negligible (< 10^-13).
  const s = String(n % 1_000_000n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
