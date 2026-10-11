import type { CheckinKind, PingKind } from '../protocol/messages';

/** How a quick message ("ping") looks in chats and notifications. */
export const PING_LABELS: Record<PingKind, { emoji: string; text: string }> = {
  'help-carry': { emoji: '🛍️', text: 'Kannst du beim Tragen helfen?' },
  'pickup-request': { emoji: '🚗', text: 'Kannst du mich abholen?' },
  'call-me': { emoji: '📞', text: 'Ruf mich bitte an' },
  'dinner-ready': { emoji: '🍽️', text: 'Essen ist fertig' },
  'running-late': { emoji: '⏰', text: 'Ich bin spät dran' },
  'on-my-way': { emoji: '🚶', text: 'Bin unterwegs' },
  'thinking-of-you': { emoji: '❤️', text: 'Denk an dich' },
  custom: { emoji: '👋', text: 'Hey!' },
};

export const CHECKIN_LABELS: Record<CheckinKind, { emoji: string; text: string }> = {
  arrived: { emoji: '✅', text: 'Gut angekommen' },
  ok: { emoji: '👍', text: 'Alles okay' },
  home: { emoji: '🏠', text: 'Bin zuhause' },
  custom: { emoji: '💬', text: 'Melde mich' },
};

export function pingText(kind: PingKind, text?: string): string {
  const l = PING_LABELS[kind];
  return `${l.emoji} ${text?.trim() || l.text}`;
}

export function checkinText(kind: CheckinKind, text?: string, placeName?: string): string {
  const l = CHECKIN_LABELS[kind];
  const main = text?.trim() || l.text;
  return placeName ? `${l.emoji} ${main} (${placeName})` : `${l.emoji} ${main}`;
}
