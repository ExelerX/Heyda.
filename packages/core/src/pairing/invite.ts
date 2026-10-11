import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import type { ContactKey } from '../transport/transport';
import { base64urlDecode, base64urlEncode } from '../util/base64url';
import { randomId } from '../util/random';

/**
 * Contacts are only ever added in person: one phone shows a QR code, the other scans it.
 * There is no search, no phone-number lookup and no public profile, so nobody can
 * be found or tracked without having met them.
 */
export const INVITE_PREFIX = 'heyda:1:';
export const INVITE_TTL_MS = 10 * 60 * 1000;

const Invite = z.strictObject({
  /** Public key of the person showing the QR code. */
  k: z.string().regex(/^[0-9a-f]{64}$/),
  /** Display name, chosen by them. */
  n: z.string().trim().min(1).max(40),
  /** Relays where they can be reached. */
  r: z.array(z.string().max(200).regex(/^wss:\/\//)).max(8),
  /** Single-use nonce; the scanner echoes it back in its hello. */
  c: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** Expiry, epoch ms. */
  e: z.number().int().positive(),
});

export interface PairingInvite {
  key: ContactKey;
  name: string;
  relays: string[];
  nonce: string;
  expiresAt: number;
}

export function encodeInvite(invite: PairingInvite): string {
  const payload = Invite.parse({
    k: invite.key,
    n: invite.name,
    r: invite.relays,
    c: invite.nonce,
    e: invite.expiresAt,
  });
  return INVITE_PREFIX + base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

export type DecodeInviteResult = { ok: true; invite: PairingInvite } | { ok: false; error: string };

export function decodeInvite(text: string, now: number = Date.now()): DecodeInviteResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith(INVITE_PREFIX) || trimmed.length > 2000) {
    return { ok: false, error: 'not a Heyda invite' };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(base64urlDecode(trimmed.slice(INVITE_PREFIX.length))));
  } catch {
    return { ok: false, error: 'invite is damaged' };
  }
  const parsed = Invite.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'invite is damaged' };
  const p = parsed.data;
  if (p.e <= now) return { ok: false, error: 'invite has expired' };
  return { ok: true, invite: { key: p.k, name: p.n, relays: p.r, nonce: p.c, expiresAt: p.e } };
}

/** Keeps the invites this device has shown, so each one can be answered only once. */
export class InviteBook {
  private readonly open = new Map<string, number>();

  create(self: { key: ContactKey; name: string; relays: string[] }, now: number = Date.now()): PairingInvite {
    this.prune(now);
    const invite = { ...self, nonce: randomId(), expiresAt: now + INVITE_TTL_MS };
    this.open.set(invite.nonce, invite.expiresAt);
    return invite;
  }

  /** True exactly once per valid, unexpired nonce. */
  consume(nonce: string, now: number = Date.now()): boolean {
    const expiresAt = this.open.get(nonce);
    this.open.delete(nonce);
    return expiresAt !== undefined && now < expiresAt;
  }

  private prune(now: number): void {
    for (const [nonce, exp] of this.open) if (exp <= now) this.open.delete(nonce);
  }
}

/**
 * A number both people can compare on their screens to rule out a swapped QR code.
 * Same for both sides because the keys are sorted first.
 */
export function safetyNumber(a: ContactKey, b: ContactKey): string {
  const [x, y] = [a, b].sort();
  const digest = sha256(new TextEncoder().encode(`heyda-safety-v1:${x}:${y}`));
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    const n = ((digest[i * 4]! << 24) | (digest[i * 4 + 1]! << 16) | (digest[i * 4 + 2]! << 8) | digest[i * 4 + 3]!) >>> 0;
    groups.push(String(n % 100_000).padStart(5, '0'));
  }
  return groups.join(' ');
}
