import type { AppMessage } from '../protocol/messages';

/** A device identity on the transport, e.g. a hex public key. */
export type ContactKey = string;

export interface IncomingMessage {
  /** Authenticated sender. The transport must guarantee this came from that key. */
  from: ContactKey;
  message: AppMessage;
  receivedAt: number;
}

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
   * Optional: hands on again messages the transport turned away because their sender was not
   * known yet. The node calls it after it learned new contacts or group members.
   */
  redeliverRefused?(): void;
}
