import type { AppMessage } from '../protocol/messages';

/** A device identity on the transport, e.g. a hex public key. */
export type ContactKey = string;

export interface IncomingMessage {
  /** Authenticated sender. The transport must guarantee this came from that key. */
  from: ContactKey;
  message: AppMessage;
  receivedAt: number;
}

/**
 * What the app does with a message (see `SocialNode.judgeMessage`): takes it now, wants it held
 * until something it waits for is here (a contact's group text before the roster), or turns it
 * down (a stranger). A transport keeps held messages apart from refused ones, so strangers cannot
 * push them out, and offers both again in `redeliverRefused`.
 */
export type Acceptance = 'accept' | 'hold' | 'refuse';

export interface SendOptions {
  /**
   * How long relays should keep the message for an offline recipient.
   * A hint only: a relay can ignore it, so nothing secret may depend on deletion. A transport may
   * also keep every message equally long, so the lifetime does not tell what kind of message it is.
   */
  ttlSeconds?: number;
  /** Publish to these relays instead of the recipient's known ones (e.g. a device being linked). */
  relays?: string[];
}

/**
 * Everything the app needs from "the network". Swapping Nostr for local P2P,
 * a relay server or Bluetooth means writing another implementation of this.
 *
 * Implementations must provide end-to-end encryption and sender authentication;
 * the rest of the app treats `IncomingMessage.from` as verified.
 */
export interface Transport {
  readonly selfKey: ContactKey;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(to: ContactKey, message: AppMessage, options?: SendOptions): Promise<void>;
  /** Registers a handler and returns a function that removes it. */
  onMessage(handler: (incoming: IncomingMessage) => void): () => void;
  /**
   * Optional: hands on again messages the transport held or turned away because their sender was
   * not known yet or the app waited for something. The node calls it after it learned new
   * contacts, group members or SOS alerts.
   */
  redeliverRefused?(): void;
  /**
   * Optional, after `start()`: resolves once what relays kept for this device while it was off has
   * been handed over. It may never resolve (offline, a relay down), so callers wait only a while.
   */
  caughtUp?(): Promise<void>;
  /**
   * Optional, while started: resolves once every relay of this device has again handed over what
   * it kept, after this call (e.g. after the device slept). May never resolve, like `caughtUp`.
   */
  caughtUpAgain?(): Promise<void>;
  /**
   * Optional, while started: since when (epoch ms, my clock) every relay of this device has handed
   * over new messages live, without a gap; undefined while one has not. Whatever was sent before
   * then has arrived. A transport without it counts as always connected (in memory).
   */
  liveSince?(): number | undefined;
}
