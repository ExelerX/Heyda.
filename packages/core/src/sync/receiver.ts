import { z } from 'zod';
import { LinkNonce, type BodyOf } from '../protocol/messages';
import { createInitialState, type LinkedDevice, type NodeState } from '../state';
import type { ContactKey, IncomingMessage } from '../transport/transport';
import { base64urlDecode, base64urlEncode } from '../util/base64url';
import { mergeSyncDoc, parseSyncDoc, type SyncDoc } from './doc';
import { LINK_SECRET_BYTES, linkCode, linkCommitment, type LinkInvite } from './link';
import { Reassembler } from './xfer';

/** What a new device receives when it is linked to an existing account. */
export interface LinkPayload {
  /** Public key of the account (the authenticated sender). */
  accountKey: string;
  secretKey: string;
  relays: string[];
  /** The device that sent the account. */
  deviceId: string;
  deviceName: string;
  devices: LinkedDevice[];
  doc: SyncDoc;
}

const deviceId = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/);
const PayloadSchema = z.object({
  format: z.literal('heyda.link'),
  v: z.literal(2),
  nonce: LinkNonce,
  secretKey: z.string().regex(/^[0-9a-f]{64}$/),
  relays: z.array(z.string().max(200).regex(/^wss:\/\//)).min(1).max(8),
  deviceId,
  deviceName: z.string().trim().min(1).max(40),
  devices: z
    .array(z.object({ deviceId, name: z.string().trim().min(1).max(40), linkedAt: z.number().int().nonnegative() }))
    .max(20),
  doc: z.unknown(),
});

/** How long after the code expired the account may still arrive (slow relays, clock skew). */
const PAYLOAD_GRACE_MS = 5 * 60_000;

/** What the new device has to do next. */
export type LinkStep =
  /** Send `message` to `to` (over `relays`), then show `code`: the other device shows it now too. */
  | { type: 'reveal'; to: ContactKey; relays: string[]; message: BodyOf<'link.reveal'>; code: string }
  /** The account arrived. Ask the person whether it is theirs before taking it over. */
  | { type: 'payload'; payload: LinkPayload };

/**
 * Runs on the new device while it shows its device code (see `sync/link.ts` for the protocol).
 * Answers only the first `link.hello` for its nonce, then takes chunks only from that sender,
 * and accepts the account only if the nonce matches and the sent identity key really belongs
 * to the sender (so nobody can push a foreign account onto it).
 */
export class LinkReceiver {
  private readonly reassembler = new Reassembler(2);
  private readonly secret: Uint8Array;
  private peer: ContactKey | undefined;
  private done = false;

  constructor(
    private readonly invite: LinkInvite,
    /** rN, the secret the code commits to. Copied; wipe your own copy. */
    secret: Uint8Array,
    /** Derives the public key of a secret key (secp256k1, from the transport library). */
    private readonly publicKeyOf: (secretKeyHex: string) => string,
  ) {
    if (secret.length !== LINK_SECRET_BYTES || linkCommitment(secret) !== invite.commit) {
      throw new Error('link secret does not match the code');
    }
    this.secret = Uint8Array.from(secret);
  }

  /** The existing device that answered the code first, once one did. */
  get peerKey(): ContactKey | undefined {
    return this.peer;
  }

  handle(incoming: IncomingMessage, now: number): LinkStep | undefined {
    if (this.done) return undefined;
    const m = incoming.message;
    if (m.type === 'link.hello') return this.onHello(incoming.from, m, now);
    if (m.type !== 'xfer.chunk' || m.purpose !== 'link') return undefined;
    // Only from the device that got my reveal: it is the one whose digits the person compares.
    if (this.peer === undefined || incoming.from !== this.peer || now > this.invite.expiresAt + PAYLOAD_GRACE_MS) return undefined;
    const raw = this.reassembler.add(incoming.from, m, now);
    if (raw === undefined) return undefined;
    const p = PayloadSchema.safeParse(raw);
    if (!p.success || p.data.nonce !== this.invite.nonce) return undefined;
    let accountKey: string;
    try {
      accountKey = this.publicKeyOf(p.data.secretKey);
    } catch {
      return undefined;
    }
    if (accountKey !== incoming.from) return undefined;
    const doc = parseSyncDoc(p.data.doc);
    if (!doc) return undefined;
    this.dispose();
    return {
      type: 'payload',
      payload: {
        accountKey,
        secretKey: p.data.secretKey,
        relays: p.data.relays,
        deviceId: p.data.deviceId,
        deviceName: p.data.deviceName,
        devices: p.data.devices,
        doc,
      },
    };
  }

  /** Wipes the secret and ignores everything from now on. Call on cancel and expiry. */
  dispose(): void {
    this.done = true;
    this.secret.fill(0);
  }

  private onHello(from: ContactKey, m: BodyOf<'link.hello'>, now: number): LinkStep | undefined {
    // One hello per code: a second answer would give an attacker a second guess at the digits.
    if (this.peer !== undefined || m.nonce !== this.invite.nonce || now > this.invite.expiresAt || from === this.invite.tempKey) return undefined;
    let rE: Uint8Array;
    try {
      rE = base64urlDecode(m.rE);
    } catch {
      return undefined;
    }
    if (rE.length !== LINK_SECRET_BYTES) return undefined;
    this.peer = from;
    const code = linkCode({ tempKey: this.invite.tempKey, nonce: this.invite.nonce, accountKey: from, rE, rN: this.secret });
    rE.fill(0);
    return {
      type: 'reveal',
      to: from,
      relays: [...new Set([...m.relays, ...this.invite.relays])],
      message: { type: 'link.reveal', nonce: this.invite.nonce, rN: base64urlEncode(this.secret) },
      code,
    };
  }
}

/** Builds the state of a freshly linked device from what the existing device sent. */
export function createLinkedState(
  payload: LinkPayload,
  self: { deviceId: string; deviceName: string },
  now: number,
): NodeState {
  const base = createInitialState({
    key: payload.accountKey,
    name: payload.doc.profileName || 'Ich',
    relays: payload.relays,
    deviceId: self.deviceId,
    deviceName: self.deviceName,
  });
  const merged: NodeState = { ...base, ...mergeSyncDoc(base, payload.doc, now) };
  const others = payload.devices.filter((d) => d.deviceId !== self.deviceId && d.deviceId !== payload.deviceId);
  return {
    ...merged,
    self: { ...merged.self, name: payload.doc.profileName || merged.self.name },
    devices: [...others, { deviceId: payload.deviceId, name: payload.deviceName, linkedAt: now }],
  };
}
