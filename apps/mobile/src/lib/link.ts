import { createLinkedState, encodeLinkInvite, LINK_TTL_MS, LinkReceiver, linkCode, randomId, type LinkPayload } from '@heyda/core';
import { DEFAULT_RELAYS, NostrTransport } from '@heyda/transport-nostr';
import { hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { deviceLabel } from './platform';
import { writeAccount } from './runtime';

export interface LinkSession {
  /** Text for the QR code this device shows. */
  code: string;
  /** The 6 digits the other device must show too. */
  digits: string;
  expiresAt: number;
  /** Resolves with the account once the other device sent it. */
  result: Promise<LinkPayload>;
  cancel: () => void;
}

/**
 * This device wants to join an existing account: it shows a code with a one-time key and
 * waits for the account to arrive, end-to-end encrypted to that key.
 */
export async function beginLinkReceive(): Promise<LinkSession> {
  const temp = generateSecretKey();
  const invite = { tempKey: getPublicKey(temp), relays: DEFAULT_RELAYS, nonce: randomId(24), expiresAt: Date.now() + LINK_TTL_MS };
  const transport = new NostrTransport({ secretKey: temp, ownRelays: invite.relays, relaysFor: () => invite.relays });
  const receiver = new LinkReceiver(invite, (hex) => getPublicKey(hexToBytes(hex)));
  let settle: (p: LinkPayload) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const result = new Promise<LinkPayload>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const timer = setTimeout(() => {
    void transport.stop();
    fail(new Error('Der Code ist abgelaufen. Starte die Verbindung neu.'));
  }, LINK_TTL_MS + 60_000);
  transport.onMessage((m) => {
    const payload = receiver.handle(m, Date.now());
    if (!payload) return;
    clearTimeout(timer);
    void transport.stop();
    settle(payload);
  });
  await transport.start();
  return {
    code: encodeLinkInvite(invite),
    digits: linkCode(invite),
    expiresAt: invite.expiresAt,
    result,
    cancel: () => {
      clearTimeout(timer);
      void transport.stop();
      temp.fill(0);
      fail(new Error('Abgebrochen.'));
    },
  };
}

/** Saves the received account as this device's account. Restart the runtime afterwards. */
export async function completeLink(payload: LinkPayload): Promise<void> {
  const state = createLinkedState(payload, { deviceId: randomId(16), deviceName: deviceLabel() }, Date.now());
  const secret = hexToBytes(payload.secretKey);
  await writeAccount(secret, state, { announceLinked: true });
  secret.fill(0);
}
