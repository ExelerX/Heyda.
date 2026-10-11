import { z } from 'zod';
import { createInitialState, type LinkedDevice, type NodeState } from '../state';
import type { IncomingMessage } from '../transport/transport';
import { mergeSyncDoc, parseSyncDoc, type SyncDoc } from './doc';
import type { LinkInvite } from './link';
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
  v: z.literal(1),
  nonce: z.string().max(64),
  secretKey: z.string().regex(/^[0-9a-f]{64}$/),
  relays: z.array(z.string().max(200).regex(/^wss:\/\//)).min(1).max(8),
  deviceId,
  deviceName: z.string().trim().min(1).max(40),
  devices: z
    .array(z.object({ deviceId, name: z.string().trim().min(1).max(40), linkedAt: z.number().int().nonnegative() }))
    .max(20),
  doc: z.unknown(),
});

/**
 * Runs on the new device while it shows its device code. Collects the chunks sent to its
 * one-time key and accepts the account only if the nonce matches its own code and the sent
 * identity key really belongs to the sender (so nobody can push a foreign account onto it).
 */
export class LinkReceiver {
  private readonly reassembler = new Reassembler(2);

  constructor(
    private readonly invite: LinkInvite,
    /** Derives the public key of a secret key (secp256k1, from the transport library). */
    private readonly publicKeyOf: (secretKeyHex: string) => string,
  ) {}

  handle(incoming: IncomingMessage, now: number): LinkPayload | undefined {
    const m = incoming.message;
    if (m.type !== 'xfer.chunk' || m.purpose !== 'link' || now > this.invite.expiresAt + 5 * 60_000) return undefined;
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
    return {
      accountKey,
      secretKey: p.data.secretKey,
      relays: p.data.relays,
      deviceId: p.data.deviceId,
      deviceName: p.data.deviceName,
      devices: p.data.devices,
      doc,
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
