import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { base64urlDecode, base64urlEncode } from '../util/base64url';

/**
 * Linking a second device (e.g. the Windows app) to an existing account.
 *
 * 1. The new device creates a throwaway key pair and shows `heyda-link:1:…` as a QR code.
 *    It holds the throwaway public key, its relays, a nonce and an expiry. No secret.
 * 2. The existing device scans it. Both screens show the same 6-digit code, derived from the
 *    throwaway key and nonce; the user checks they match, which rules out a swapped QR code.
 * 3. The existing device sends the account (identity key, contacts, settings) end-to-end
 *    encrypted to the throwaway key, in chunks. Only the new device can read it.
 */
export const LINK_PREFIX = 'heyda-link:1:';
export const LINK_TTL_MS = 10 * 60 * 1000;

const LinkInviteSchema = z.strictObject({
  t: z.string().regex(/^[0-9a-f]{64}$/),
  r: z.array(z.string().max(200).regex(/^wss:\/\//)).min(1).max(8),
  n: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  e: z.number().int().positive(),
});

export interface LinkInvite {
  /** Throwaway public key of the new device. */
  tempKey: string;
  relays: string[];
  nonce: string;
  expiresAt: number;
}

export function encodeLinkInvite(invite: LinkInvite): string {
  const payload = LinkInviteSchema.parse({ t: invite.tempKey, r: invite.relays, n: invite.nonce, e: invite.expiresAt });
  return LINK_PREFIX + base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

export type DecodeLinkResult = { ok: true; invite: LinkInvite } | { ok: false; error: string };

export function decodeLinkInvite(text: string, now: number): DecodeLinkResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith(LINK_PREFIX) || trimmed.length > 2000) return { ok: false, error: 'Kein Geräte-Code von Heyda.' };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(base64urlDecode(trimmed.slice(LINK_PREFIX.length))));
  } catch {
    return { ok: false, error: 'Der Code ist beschädigt.' };
  }
  const p = LinkInviteSchema.safeParse(json);
  if (!p.success) return { ok: false, error: 'Der Code ist beschädigt.' };
  if (p.data.e <= now) return { ok: false, error: 'Der Code ist abgelaufen. Lass einen neuen anzeigen.' };
  return { ok: true, invite: { tempKey: p.data.t, relays: p.data.r, nonce: p.data.n, expiresAt: p.data.e } };
}

/** The 6-digit code both screens show, e.g. "482 913". */
export function linkCode(invite: Pick<LinkInvite, 'tempKey' | 'nonce'>): string {
  const d = sha256(new TextEncoder().encode(`heyda-link-v1:${invite.tempKey}:${invite.nonce}`));
  const n = ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
  const s = String(n % 1_000_000).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
