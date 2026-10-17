import { composeMessage, createLinkedState, createLinkInvite, encodeLinkInvite, LINK_TTL_MS, LinkReceiver, randomId, TTL, type LinkPayload } from '@heyda/core';
import { DEFAULT_RELAYS, NostrTransport } from '@heyda/transport-nostr';
import { hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { deviceLabel } from './platform';
import { writeAccount } from './runtime';

export interface LinkSession {
  /** Text for the QR code this device shows. */
  code: string;
  expiresAt: number;
  /**
   * The 6 digits to compare. Resolves only once the other device answered and got this
   * device's reveal, because before that there is nothing to compare. Never rejects.
   */
  digits: Promise<string>;
  /**
   * The person saw the same digits on the other device and tapped "Zahlen stimmen überein"
   * here. Without this, an account that arrives is never handed out (see core `sync/link.ts`).
   */
  confirmDigits: () => void;
  /** Resolves with the account once the other device sent it and the digits were confirmed here. */
  result: Promise<LinkPayload>;
  cancel: () => void;
}

/**
 * This device wants to join an existing account: it shows a code with a one-time key and a
 * commitment to a secret, answers the first device that scans it with that secret, and waits
 * for the account to arrive, end-to-end encrypted to the one-time key (see core `sync/link.ts`).
 */
export async function beginLinkReceive(): Promise<LinkSession> {
  const temp = generateSecretKey();
  const { invite, secret } = createLinkInvite({ tempKey: getPublicKey(temp), relays: DEFAULT_RELAYS, now: Date.now() });
  const transport = new NostrTransport({ secretKey: temp, ownRelays: invite.relays, relaysFor: () => invite.relays });
  // The transport keeps its own copy of the one-time key and wipes it in dispose().
  temp.fill(0);
  const receiver = new LinkReceiver(invite, secret, (hex) => getPublicKey(hexToBytes(hex)));
  secret.fill(0);
  let settle: (p: LinkPayload) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const result = new Promise<LinkPayload>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let showDigits: (d: string) => void = () => {};
  const digits = new Promise<string>((resolve) => (showDigits = resolve));
  // Set once a reveal went out and the digits are on screen.
  let shown = false;
  let done = false;
  // The one-time key and the secret are useless afterwards; don't leave them in memory.
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    receiver.dispose();
    void transport.dispose().catch(() => {});
  };
  const timer = setTimeout(() => {
    finish();
    fail(new Error('Der Code ist abgelaufen. Starte die Verbindung neu.'));
  }, LINK_TTL_MS + 60_000);
  transport.onMessage((m) => {
    if (done) return;
    const step = receiver.handle(m, Date.now());
    if (!step) return;
    if (step.type === 'payload') {
      finish();
      settle(step.payload);
      return;
    }
    // The first answer, or the same one again when the other device repeated its hello.
    transport.send(step.to, composeMessage(step.message), { ttlSeconds: TTL.link, relays: step.relays }).then(
      () => {
        if (done) return;
        shown = true;
        showDigits(step.code);
      },
      () => {
        // A repeat that failed changes nothing: the first answer went out.
        if (done || shown) return;
        // The other device waits for an answer that never comes; only a new code helps.
        finish();
        fail(new Error('Keine Verbindung zu deinem anderen Gerät. Prüfe dein Internet und starte neu.'));
      },
    );
  });
  try {
    await transport.start();
  } catch (e) {
    finish();
    throw e;
  }
  return {
    code: encodeLinkInvite(invite),
    expiresAt: invite.expiresAt,
    digits,
    confirmDigits: () => {
      if (done || !shown) return;
      const step = receiver.confirmCode();
      if (step?.type !== 'payload') return;
      finish();
      settle(step.payload);
    },
    result,
    cancel: () => {
      finish();
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
