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

/**
 * How the end of a contact's SOS reads. `removed`: they removed me as a contact, so no more
 * updates come. It must not sound like the emergency is over, since it may not be.
 */
export function sosEndText(name: string, reason: 'safe' | 'cancelled' | 'removed' | undefined): { title: string; body: string } {
  switch (reason) {
    case 'safe':
      return { title: `✅ ${name} ist in Sicherheit`, body: 'Der Notruf ist beendet.' };
    case 'removed':
      return { title: `${name}: keine Notruf-Updates mehr`, body: `Du bekommst von ${name} keine Notruf-Updates mehr. Ob der Notruf vorbei ist, weißt du damit nicht.` };
    default:
      return { title: `${name} hat den Notruf abgebrochen`, body: 'Es war wohl ein Versehen.' };
  }
}
