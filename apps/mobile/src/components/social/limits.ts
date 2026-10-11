import {
  ChatTextMessage,
  GroupUpdateMessage,
  MAX_GROUP_MEMBERS,
  MAX_LOCATION_INPUT,
  MAX_SESSION_RECIPIENTS,
  PingMessage,
  SessionStartMessage,
  WhereReplyMessage,
} from '@heyda/core';

/** Read a length limit straight from the wire schema, so the inputs never allow more than the protocol. */
const max = (schema: { maxLength: number | null }, fallback: number): number => schema.maxLength ?? fallback;

export const LIMITS = {
  chat: max(ChatTextMessage.shape.text, 4000),
  pingText: max(PingMessage.shape.text.unwrap(), 280),
  groupName: max(GroupUpdateMessage.shape.name, 40),
  /** Including me. */
  groupMembers: MAX_GROUP_MEMBERS,
  whereText: max(WhereReplyMessage.shape.text.unwrap(), 140),
  destinationName: max(SessionStartMessage.shape.destinationName, 60),
  tripRecipients: MAX_SESSION_RECIPIENTS,
  locationInput: MAX_LOCATION_INPUT,
  /** `updateContact` keeps 40 characters of a nickname and 32 of a phone number. */
  nickname: 40,
  phone: 32,
  /** Invite codes are at most 2000 characters (pairing/invite.ts). */
  invite: 2000,
} as const;
