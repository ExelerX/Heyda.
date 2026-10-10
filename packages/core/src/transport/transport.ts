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
   * A hint only: a relay can ignore it, so nothing secret may depend on deletion.
   */
  ttlSeconds?: number;
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
}
