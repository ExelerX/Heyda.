import { randomId } from '../util/random';
import { PROTOCOL_VERSION, type AppMessage, type AppMessageBody } from './messages';

/** Adds version, a fresh id and the send time to a message body. */
export function composeMessage(body: AppMessageBody, now: number = Date.now()): AppMessage {
  return { ...body, v: PROTOCOL_VERSION, id: randomId(), sentAt: now } as AppMessage;
}
