import type { Action, Condition, Rule, Trigger } from './schema';

export interface DescribeNames {
  contactName: (key: string) => string;
  placeName: (placeId: string) => string;
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/**
 * One plain German sentence for a rule. Shown before activating anything that
 * came from a plugin or an AI suggestion, and read out by screen readers.
 */
export function describeRule(rule: Rule, names: DescribeNames): string {
  const conds = rule.conditions.map((c) => describeCondition(c, names));
  const actions = rule.actions.map((a) => describeAction(a, names));
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
    case 'contact.ping': {
      const what =
        t.kind === 'help-carry'
          ? 'um Hilfe beim Tragen bittet'
          : t.kind === 'pickup-request'
            ? 'abgeholt werden möchte'
            : 'dich anstupst';
      return `Wenn ${who(t.contact, n)} ${what}`;
    }
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

function describeAction(a: Action, n: DescribeNames): string {
  switch (a.do) {
    case 'notify':
      return `zeige „${a.title}“ an`;
    case 'send_ping': {
      const to = n.contactName(a.to);
      if (a.kind === 'help-carry') return `bitte ${to} um Hilfe beim Tragen`;
      if (a.kind === 'pickup-request') return `bitte ${to}, dich abzuholen`;
      return `schicke ${to} „${a.text ?? '👋'}“`;
    }
    case 'start_trip':
      return `teile deine Ankunftszeit nach „${n.placeName(a.destination)}“ mit ${a.to.map(n.contactName).join(', ')}`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}
