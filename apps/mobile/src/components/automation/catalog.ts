import { contactLabel, DEFAULT_LIMITS, validateRule, type Action, type Condition, type NodeState, type Rule, type RuleSource, type Trigger } from '@heyda/core';

/**
 * The building blocks of the rule editor: every trigger, condition and action the core
 * automation schema supports, with German labels, icons and sensible starting values.
 * Drafts are loose objects while editing; `buildRule` cleans them and the core schema
 * has the final word.
 */
export type Obj = Record<string, unknown>;
export type TriggerOn = Trigger['on'];
export type ConditionIf = Condition['if'];
export type ActionDo = Action['do'];

export interface BlockInfo<K extends string> {
  key: K;
  icon: string;
  title: string;
  detail: string;
}

export const TRIGGERS: (BlockInfo<TriggerOn> & { group: 'friend' | 'me'; needs?: string })[] = [
  { key: 'contact.arrive', group: 'friend', icon: '📍', title: 'Jemand kommt an', detail: 'an einem Ort, den die Person dir freigibt', needs: 'Klappt nur, wenn die Person dir den Ort in ihrer App freigegeben hat.' },
  { key: 'contact.leave', group: 'friend', icon: '🚶', title: 'Jemand geht los', detail: 'von einem Ort, den die Person dir freigibt', needs: 'Klappt nur, wenn die Person dir den Ort in ihrer App freigegeben hat.' },
  { key: 'contact.eta_below', group: 'friend', icon: '⏱️', title: 'Jemand ist gleich da', detail: 'die geteilte Ankunftszeit wird kurz', needs: 'Klappt, wenn die Person ihre Ankunftszeit mit dir teilt.' },
  { key: 'contact.trip_start', group: 'friend', icon: '🚗', title: 'Jemand fährt los', detail: 'und teilt die Ankunftszeit mit dir', needs: 'Klappt, wenn die Person ihre Ankunftszeit mit dir teilt.' },
  { key: 'contact.trip_end', group: 'friend', icon: '🏁', title: 'Jemand ist am Ziel', detail: 'oder beendet das Teilen' },
  { key: 'contact.message', group: 'friend', icon: '💬', title: 'Jemand schreibt dir', detail: 'optional mit einem bestimmten Wort' },
  { key: 'contact.ping', group: 'friend', icon: '👋', title: 'Jemand schickt einen Ping', detail: 'z. B. „Kannst du mich abholen?“' },
  { key: 'contact.checkin', group: 'friend', icon: '✅', title: 'Jemand meldet sich', detail: 'z. B. „Gut angekommen“' },
  { key: 'contact.sos', group: 'friend', icon: '🆘', title: 'Jemand sendet einen Notruf', detail: 'an dich' },
  { key: 'me.arrive', group: 'me', icon: '🏠', title: 'Ich komme an', detail: 'an einem meiner Orte', needs: 'Braucht Standort „Immer erlauben“ auf deinem Handy.' },
  { key: 'me.leave', group: 'me', icon: '🚪', title: 'Ich gehe los', detail: 'von einem meiner Orte', needs: 'Braucht Standort „Immer erlauben“ auf deinem Handy.' },
];

export const CONDITIONS: BlockInfo<ConditionIf>[] = [
  { key: 'time_between', icon: '🕙', title: 'Zu einer Uhrzeit', detail: 'z. B. nur zwischen 22 und 6 Uhr' },
  { key: 'weekday', icon: '📅', title: 'An bestimmten Tagen', detail: 'z. B. nur werktags' },
  { key: 'me.at', icon: '📍', title: 'Während ich an einem Ort bin', detail: 'z. B. nur, wenn ich zuhause bin' },
  { key: 'me.not_at', icon: '🧭', title: 'Während ich nicht dort bin', detail: 'z. B. nur, wenn ich nicht zuhause bin' },
];

export const ACTIONS: BlockInfo<ActionDo>[] = [
  { key: 'notify', icon: '🔔', title: 'Mir Bescheid sagen', detail: 'eine Benachrichtigung auf diesem Gerät' },
  { key: 'send_ping', icon: '👋', title: 'Einen Ping schicken', detail: 'z. B. „Bin unterwegs“' },
  { key: 'send_message', icon: '💬', title: 'Eine Nachricht schreiben', detail: 'in deinem Namen' },
  { key: 'send_checkin', icon: '✅', title: 'Mich melden', detail: 'z. B. „Gut angekommen“ an bis zu 10 Personen' },
  { key: 'set_dnd', icon: '🌙', title: 'Ruhemodus', detail: 'an für eine Zeit, oder aus' },
  { key: 'set_status', icon: '🏷️', title: 'Status setzen', detail: 'z. B. „🏠 Zuhause“' },
  { key: 'start_trip', icon: '🚗', title: 'Ankunftszeit teilen', detail: 'nur die Zeit, nie den Standort' },
];

export const triggerInfo = (on: unknown) => TRIGGERS.find((x) => x.key === on);
export const conditionInfo = (k: unknown) => CONDITIONS.find((x) => x.key === k);
export const actionInfo = (k: unknown) => ACTIONS.find((x) => x.key === k);

/** Placeholders a trigger fills in (see the engine's variables()). */
export function variablesFor(trigger: Obj | undefined): string[] {
  switch (trigger?.on) {
    case 'contact.arrive':
    case 'contact.leave':
      return ['contact', 'place'];
    case 'contact.eta_below':
      return ['contact', 'eta', 'destination'];
    case 'contact.trip_start':
      return ['contact', 'destination'];
    case 'contact.message':
    case 'contact.ping':
      return ['contact', 'text'];
    case 'contact.checkin':
      return ['contact', 'text', 'place'];
    case 'contact.trip_end':
    case 'contact.sos':
      return ['contact'];
    case 'me.arrive':
    case 'me.leave':
      return ['place'];
    default:
      return [];
  }
}

/** The concrete person a trigger is about, if any (to pre-fill "send to"). */
function triggerContact(trigger: Obj | undefined): string | undefined {
  const c = trigger?.contact;
  return typeof c === 'string' && /^[0-9a-f]{64}$/.test(c) ? c : undefined;
}

export function newTrigger(on: TriggerOn, prev: Obj | undefined, state: NodeState): Obj {
  const contact = typeof prev?.contact === 'string' ? prev.contact : 'any';
  const firstPlace = state.places[0]?.id ?? '';
  const myPlace = typeof prev?.place === 'string' && state.places.some((p) => p.id === prev.place) ? prev.place : firstPlace;
  switch (on) {
    case 'contact.eta_below':
      return { on, contact, minutes: 5 };
    case 'contact.trip_end':
      return { on, contact, reason: 'arrived' };
    case 'me.arrive':
    case 'me.leave':
      return { on, place: myPlace };
    default:
      return { on, contact };
  }
}

export function newCondition(kind: ConditionIf, state: NodeState): Obj {
  switch (kind) {
    case 'time_between':
      return { if: kind, from: '22:00', to: '06:00' };
    case 'weekday':
      return { if: kind, days: [1, 2, 3, 4, 5] };
    default:
      return { if: kind, place: state.places[0]?.id ?? '' };
  }
}

function notifyDefaults(trigger: Obj | undefined): { title: string; body: string } {
  switch (trigger?.on) {
    case 'contact.arrive':
      return { title: '{{contact}} ist da', body: '{{contact}} ist bei {{place}} angekommen.' };
    case 'contact.leave':
      return { title: '{{contact}} ist losgegangen', body: '{{contact}} hat {{place}} verlassen.' };
    case 'contact.eta_below':
      return { title: '{{contact}} ist gleich da', body: '{{contact}} kommt {{eta}} an.' };
    case 'contact.trip_start':
      return { title: '{{contact}} ist unterwegs', body: 'Ziel: {{destination}}' };
    case 'contact.trip_end':
      return { title: '{{contact}} ist angekommen', body: '{{contact}} hat das Teilen beendet.' };
    case 'contact.message':
      return { title: 'Nachricht von {{contact}}', body: '{{text}}' };
    case 'contact.ping':
      return { title: '{{contact}} meldet sich', body: '{{text}}' };
    case 'contact.checkin':
      return { title: '{{contact}} hat sich gemeldet', body: '{{text}}' };
    case 'contact.sos':
      return { title: '{{contact}} braucht Hilfe', body: 'Schau sofort in Heyda. nach.' };
    case 'me.arrive':
      return { title: 'Angekommen', body: 'Du bist bei {{place}}.' };
    case 'me.leave':
      return { title: 'Losgegangen', body: 'Du hast {{place}} verlassen.' };
    default:
      return { title: 'Erinnerung', body: 'Deine Automation hat ausgelöst.' };
  }
}

export function newAction(kind: ActionDo, trigger: Obj | undefined, state: NodeState): Obj {
  const who = triggerContact(trigger);
  switch (kind) {
    case 'notify':
      return { do: kind, ...notifyDefaults(trigger) };
    case 'send_ping':
      return { do: kind, to: who ?? '', kind: 'on-my-way' };
    case 'send_message':
      return { do: kind, to: who ?? '', text: '' };
    case 'send_checkin':
      return { do: kind, to: who ? [who] : [], kind: 'arrived' };
    case 'set_dnd':
      return { do: kind, minutes: 60 };
    case 'set_status':
      return { do: kind, emoji: '🏠', text: 'Zuhause', hours: 2 };
    case 'start_trip':
      return { do: kind, to: who ? [who] : [], destination: state.places[0]?.id ?? '', level: 'eta' };
  }
}

/** Optional fields per block type: removed when left empty. */
const OPTIONAL: Record<string, string[]> = {
  'contact.arrive': ['place'],
  'contact.leave': ['place'],
  'contact.trip_end': ['reason'],
  'contact.message': ['contains'],
  'contact.ping': ['kind'],
  'contact.checkin': ['kind'],
  send_ping: ['text'],
  send_checkin: ['text'],
  set_status: ['emoji'],
};

function clean(block: Obj, type: string): Obj {
  const optional = OPTIONAL[type] ?? [];
  const out: Obj = {};
  for (const [k, v] of Object.entries(block)) {
    const value = typeof v === 'string' ? v.trim() : v;
    if (value === undefined || value === null) continue;
    if (optional.includes(k) && value === '') continue;
    out[k] = value;
  }
  return out;
}

export interface Draft {
  id: string;
  name: string;
  enabled: boolean;
  trigger?: Obj;
  conditions: Obj[];
  actions: Obj[];
  source: RuleSource;
  templateId?: string;
}

const isKey = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Friendly German problems, in the order they appear on screen. Empty when ready to save. */
export function draftProblems(d: Draft, state: NodeState): string[] {
  const out: string[] = [];
  const isContact = (k: unknown) => isKey(k) && state.contacts.some((c) => c.key === k);
  const isPlace = (p: unknown) => typeof p === 'string' && state.places.some((x) => x.id === p);
  const t = d.trigger;
  if (!t) out.push('Wähle bei „Wenn“, wann es losgehen soll.');
  else if (String(t.on).startsWith('contact.')) {
    if (t.contact !== 'any' && !isContact(t.contact)) out.push('Wenn: Wähle eine Person oder „jemand“.');
    if (t.on === 'contact.message' && text(t.contains).length > 60) out.push('Wenn: Das Wort darf höchstens 60 Zeichen haben.');
    if ((t.on === 'contact.arrive' || t.on === 'contact.leave') && text(t.place).length > 60) out.push('Wenn: Der Ortsname darf höchstens 60 Zeichen haben.');
  } else if (!isPlace(t.place)) out.push('Wenn: Wähle einen deiner Orte.');

  d.conditions.forEach((c, i) => {
    const n = `Und nur wenn ${d.conditions.length > 1 ? `(${i + 1})` : ''}`.trim();
    if (c.if === 'time_between') {
      const ok = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
      if (!ok(c.from) || !ok(c.to)) out.push(`${n}: Uhrzeiten bitte wie 07:30 oder 22:00.`);
      else if (c.from === c.to) out.push(`${n}: Start und Ende sind gleich.`);
    } else if (c.if === 'weekday') {
      if (!Array.isArray(c.days) || !c.days.length) out.push(`${n}: Wähle mindestens einen Tag.`);
    } else if (!isPlace(c.place)) out.push(`${n}: Wähle einen deiner Orte.`);
  });

  if (!d.actions.length) out.push('Wähle bei „Dann“ mindestens eine Aktion.');
  d.actions.forEach((a, i) => {
    const n = `Dann ${d.actions.length > 1 ? `(${i + 1})` : ''}`.trim();
    switch (a.do) {
      case 'notify':
        if (!text(a.title)) out.push(`${n}: Die Überschrift fehlt.`);
        if (!text(a.body)) out.push(`${n}: Der Text fehlt.`);
        break;
      case 'send_ping':
        if (!isContact(a.to)) out.push(`${n}: Wähle, an wen der Ping geht.`);
        break;
      case 'send_message':
        if (!isContact(a.to)) out.push(`${n}: Wähle, an wen die Nachricht geht.`);
        if (!text(a.text)) out.push(`${n}: Schreib, was in der Nachricht stehen soll.`);
        break;
      case 'send_checkin':
      case 'start_trip': {
        const to = Array.isArray(a.to) ? a.to : [];
        if (!to.length || !to.every(isContact)) out.push(`${n}: Wähle mindestens eine Person.`);
        if (a.do === 'start_trip' && !isPlace(a.destination)) out.push(`${n}: Wähle das Ziel.`);
        break;
      }
      case 'set_status':
        if (!text(a.text)) out.push(`${n}: Schreib einen Status-Text.`);
        break;
      default:
        break;
    }
  });
  return out;
}

/** A short automatic name when the user leaves the name empty. */
export function autoName(d: Draft, state: NodeState): string {
  const info = triggerInfo(d.trigger?.on);
  const action = actionInfo(d.actions[0]?.do);
  const who = state.contacts.find((c) => c.key === d.trigger?.contact);
  const when = who && info ? info.title.replace(/^Jemand/, contactLabel(who)) : info?.title;
  return [when, action?.title].filter(Boolean).join(' → ').slice(0, 60) || 'Meine Automation';
}

const FIELD_TEXT: Record<string, string> = {
  contact: 'Person',
  place: 'Ort',
  minutes: 'Minuten',
  contains: 'Wort',
  title: 'Überschrift',
  body: 'Text',
  text: 'Text',
  to: 'Empfänger',
  kind: 'Art',
  from: 'Von',
  days: 'Tage',
  hours: 'Stunden',
  destination: 'Ziel',
  emoji: 'Emoji',
  name: 'Name',
  reason: 'Grund',
};

/** Turns a core schema error path ("actions.0.text: …") into German. */
function friendlyIssue(issue: string): string {
  const [path = ''] = issue.split(':');
  const parts = path.split('.');
  const where =
    parts[0] === 'trigger' ? 'Wenn' : parts[0] === 'conditions' ? `Und nur wenn (${Number(parts[1]) + 1})` : parts[0] === 'actions' ? `Dann (${Number(parts[1]) + 1})` : parts[0] === 'name' ? 'Name' : 'Automation';
  const field = parts[0] === 'trigger' ? parts[1] : parts[2];
  return `${where}: ${field ? `${FIELD_TEXT[field] ?? field} passt nicht` : 'bitte prüfen'}.`;
}

export type BuildResult = { ok: true; rule: Rule } | { ok: false; errors: string[] };

/** Cleans the draft and checks it with the core schema. */
export function buildRule(d: Draft, state: NodeState): BuildResult {
  const problems = draftProblems(d, state);
  if (problems.length || !d.trigger) return { ok: false, errors: problems };
  const input: Obj = {
    id: d.id,
    name: (d.name.trim() || autoName(d, state)).slice(0, 60),
    enabled: d.enabled,
    trigger: clean(d.trigger, String(d.trigger.on)),
    conditions: d.conditions.map((c) => clean(c, String(c.if))),
    actions: d.actions.map((a) => clean(a, String(a.do))),
    source: d.source,
  };
  if (d.templateId) input.templateId = d.templateId;
  const r = validateRule(input);
  return r.ok ? { ok: true, rule: r.value } : { ok: false, errors: [...new Set(r.errors.map(friendlyIssue))] };
}

export const LIMITS_TEXT = `Jede Automation löst höchstens ${DEFAULT_LIMITS.maxFiresPerRulePerHour}-mal pro Stunde aus, mit mindestens ${Math.round(
  DEFAULT_LIMITS.ruleCooldownMs / 60_000,
)} Minute Abstand. An dieselbe Person gehen höchstens ${DEFAULT_LIMITS.maxPingsPerContactPerHour} automatische Nachrichten pro Stunde.`;

export const MAX_CONDITIONS = 8;
export const MAX_ACTIONS = 5;
