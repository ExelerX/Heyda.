import { CHECKIN_LABELS, PING_LABELS } from '../features/labels';
import type { CheckinKind, PingKind } from '../protocol/messages';
import type { Action, Condition, Rule, Trigger } from './schema';

export const PING_TRIGGER_TEXT: Record<PingKind, string> = {
  'help-carry': 'um Hilfe beim Tragen bittet',
  'pickup-request': 'abgeholt werden möchte',
  'call-me': 'um einen Anruf bittet',
  'dinner-ready': '„Essen ist fertig“ schickt',
  'running-late': 'sich verspätet',
  'on-my-way': '„bin unterwegs“ schickt',
  'thinking-of-you': 'ein Herz schickt',
  custom: 'dich anstupst',
};

const PING_ACTION_TEXT: Record<PingKind, string> = Object.fromEntries(
  Object.entries(PING_LABELS).map(([k, v]) => [k, `${v.text} ${v.emoji}`]),
) as Record<PingKind, string>;

export const CHECKIN_TEXT: Record<CheckinKind, string> = Object.fromEntries(
  Object.entries(CHECKIN_LABELS).map(([k, v]) => [k, v.text]),
) as Record<CheckinKind, string>;

export function durationText(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 Stunde' : `${minutes / 60} Stunden`;
  return `${minutes} Minuten`;
}

export interface DescribeNames {
  /** How I see someone (my nickname for them, if I gave one). */
  contactName: (key: string) => string;
  /** The name they chose, which is what messages to others say. Defaults to `contactName`. */
  sentName?: (key: string) => string;
  placeName: (placeId: string) => string;
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/**
 * One plain German sentence for a rule. Shown before activating anything that
 * came from a plugin or an AI suggestion, and read out by screen readers.
 */
export function describeRule(rule: Rule, names: DescribeNames): string {
  const conds = rule.conditions.map((c) => describeCondition(c, names));
  const actions = rule.actions.map((a) => describeAction(a, names, rule.trigger));
  const when = describeTrigger(rule.trigger, names) + (conds.length ? `, ${conds.join(' und ')}` : '');
  return `${when}: ${capitalize(actions.join(' und '))}.`;
}

function who(ref: string, names: DescribeNames): string {
  return ref === 'any' ? 'jemand' : names.contactName(ref);
}

function describeTrigger(t: Trigger, n: DescribeNames): string {
  switch (t.on) {
    case 'contact.arrive':
      return `Wenn ${who(t.contact, n)} ${t.place ? `bei „${t.place}“` : 'irgendwo'} ankommt`;
    case 'contact.leave':
      return `Wenn ${who(t.contact, n)} ${t.place ? `„${t.place}“` : 'einen Ort'} verlässt`;
    case 'contact.eta_below':
      return t.minutes === 0
        ? `Wenn ${who(t.contact, n)} gleich ankommt`
        : `Wenn ${who(t.contact, n)} weniger als ${t.minutes} Minuten entfernt ist`;
    case 'contact.trip_start':
      return `Wenn ${who(t.contact, n)} losfährt`;
    case 'contact.trip_end':
      return t.reason === 'arrived'
        ? `Wenn ${who(t.contact, n)} angekommen ist`
        : `Wenn ${who(t.contact, n)} das Teilen beendet`;
    case 'contact.message':
      return `Wenn ${who(t.contact, n)} schreibt${t.contains ? ` und „${t.contains}“ darin vorkommt` : ''}`;
    case 'contact.ping':
      return `Wenn ${who(t.contact, n)} ${PING_TRIGGER_TEXT[t.kind ?? 'custom']}`;
    case 'contact.checkin':
      return t.kind
        ? `Wenn ${who(t.contact, n)} „${CHECKIN_TEXT[t.kind]}“ meldet`
        : `Wenn ${who(t.contact, n)} sich meldet`;
    case 'contact.sos':
      return `Wenn ${who(t.contact, n)} einen Notruf sendet`;
    case 'me.arrive':
      return `Wenn ich bei „${n.placeName(t.place)}“ ankomme`;
    case 'me.leave':
      return `Wenn ich „${n.placeName(t.place)}“ verlasse`;
  }
}

function describeCondition(c: Condition, n: DescribeNames): string {
  switch (c.if) {
    case 'time_between':
      return `zwischen ${c.from} und ${c.to} Uhr`;
    case 'weekday':
      return `am ${[...c.days].sort().map((d) => WEEKDAYS[d - 1]).join(', ')}`;
    case 'me.at':
      return `während ich bei „${n.placeName(c.place)}“ bin`;
    case 'me.not_at':
      return `während ich nicht bei „${n.placeName(c.place)}“ bin`;
  }
}

/**
 * Shows `{{contact}}` etc. the way they will read when the rule fires. `out`: the text goes to
 * other people, so it names the person the way they named themselves, never by my nickname.
 */
function fillVariables(text: string, t: Trigger, n: DescribeNames, out = true): string {
  const person = out ? (n.sentName ?? n.contactName) : n.contactName;
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, name: string) => {
    if (name === 'contact' && 'contact' in t) return t.contact === 'any' ? '[Person]' : person(t.contact);
    if (name === 'place' && 'place' in t && t.place) return t.on.startsWith('me.') ? n.placeName(t.place) : t.place;
    if (name === 'eta') return 'in X min';
    const label: Record<string, string> = { place: 'Ort', destination: 'Ziel', text: 'Nachricht' };
    return `[${label[name] ?? '…'}]`;
  });
}

function describeAction(a: Action, n: DescribeNames, t: Trigger): string {
  switch (a.do) {
    case 'notify':
      return `zeige „${fillVariables(a.title, t, n, false)}“ an`;
    case 'send_ping': {
      const to = n.contactName(a.to);
      // Its own text replaces the label for every kind of ping (see `pingText`): it is what they read.
      if (a.text?.trim()) return `schicke ${to} „${PING_LABELS[a.kind].emoji} ${fillVariables(a.text, t, n)}“`;
      return `schicke ${to} „${PING_ACTION_TEXT[a.kind]}“`;
    }
    case 'send_message':
      return `schreibe ${n.contactName(a.to)} „${fillVariables(a.text, t, n)}“`;
    case 'send_checkin':
      return `melde ${a.to.map(n.contactName).join(', ')} „${a.text ? fillVariables(a.text, t, n) : CHECKIN_TEXT[a.kind]}“`;
    case 'set_dnd':
      return a.minutes === 0 ? 'schalte den Ruhemodus aus' : `schalte den Ruhemodus für ${durationText(a.minutes)} an`;
    case 'set_status':
      return `setze deinen Status auf „${[a.emoji, fillVariables(a.text, t, n)].filter(Boolean).join(' ')}“`;
    case 'start_trip':
      return `teile deine Ankunftszeit nach „${n.placeName(a.destination)}“ mit ${a.to.map(n.contactName).join(', ')}`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}
