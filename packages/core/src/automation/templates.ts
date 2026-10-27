import { z } from 'zod';
import { randomId } from '../util/random';
import { validateRule, type Rule, type RuleSource, type ValidateResult } from './schema';

/**
 * A no-code automation: a sentence with gaps the user fills in by tapping,
 * e.g. "Tell me when {contact} arrives at {place}".
 * The rule inside uses `{{slot:name}}` placeholders that get replaced by the choices.
 */
export const TEMPLATE_CATEGORIES = ['ankunft', 'unterwegs', 'reise', 'sicherheit', 'familie', 'freunde', 'ruhe', 'alltag'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const SlotKind = z.enum(['contact', 'place_name', 'my_place', 'minutes', 'duration', 'text']);
export type SlotKind = z.infer<typeof SlotKind>;

export const SlotDef = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
  kind: SlotKind,
  label: z.string().trim().min(1).max(40),
  /** For `contact` slots: whether "anyone" is a valid choice. */
  allowAny: z.boolean().optional(),
  default: z.union([z.string().max(200), z.number()]).optional(),
});
export type SlotDef = z.infer<typeof SlotDef>;

export const RuleTemplate = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/).max(120),
  title: z.string().trim().min(1).max(60),
  /** The sentence shown to the user; `{slot}` marks a gap. */
  sentence: z.string().trim().min(1).max(160),
  category: z.enum(TEMPLATE_CATEGORIES),
  slots: z.array(SlotDef).max(6),
  rule: z.strictObject({
    name: z.string().trim().min(1).max(60),
    trigger: z.record(z.string(), z.unknown()),
    conditions: z.array(z.record(z.string(), z.unknown())).max(8),
    actions: z.array(z.record(z.string(), z.unknown())).min(1).max(5),
  }),
});
export type RuleTemplate = z.infer<typeof RuleTemplate>;

export type SlotValues = Record<string, string | number>;

const PLACEHOLDER = /\{\{slot:([a-z][a-z0-9_]{0,30})\}\}/g;

function checkSlotValue(slot: SlotDef, value: string | number | undefined): string | undefined {
  if (value === undefined) return `${slot.label} fehlt`;
  switch (slot.kind) {
    case 'contact':
      if (value === 'any' && slot.allowAny) return undefined;
      return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? undefined : `${slot.label}: kein gültiger Kontakt`;
    case 'minutes':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 120
        ? undefined
        : `${slot.label}: 0 bis 120 Minuten`;
    case 'duration':
      // Quiet-mode length in minutes: 15 minutes to a day.
      return typeof value === 'number' && Number.isInteger(value) && value >= 15 && value <= 1440
        ? undefined
        : `${slot.label}: 15 Minuten bis 24 Stunden`;
    case 'my_place':
      return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? undefined : `${slot.label}: kein gültiger Ort`;
    case 'place_name':
      return typeof value === 'string' && value.trim().length >= 1 && value.length <= 60
        ? undefined
        : `${slot.label}: 1 bis 60 Zeichen`;
    case 'text':
      return typeof value === 'string' && value.trim().length >= 1 && value.length <= 200
        ? undefined
        : `${slot.label}: 1 bis 200 Zeichen`;
  }
}

function substitute(node: unknown, values: SlotValues): unknown {
  if (typeof node === 'string') {
    const whole = /^\{\{slot:([a-z][a-z0-9_]{0,30})\}\}$/.exec(node);
    if (whole) return values[whole[1]!];
    return node.replace(PLACEHOLDER, (_, name: string) => String(values[name] ?? ''));
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, values));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, values)]));
  }
  return node;
}

/** Names of all `{{slot:x}}` placeholders used anywhere inside a template's rule. */
export function placeholdersIn(node: unknown, found = new Set<string>()): Set<string> {
  if (typeof node === 'string') for (const m of node.matchAll(PLACEHOLDER)) found.add(m[1]!);
  else if (Array.isArray(node)) node.forEach((n) => placeholdersIn(n, found));
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => placeholdersIn(v, found));
  return found;
}

export function instantiateTemplate(
  template: RuleTemplate,
  values: SlotValues,
  options: { id?: string; source?: RuleSource } = {},
): ValidateResult<Rule> {
  const errors: string[] = [];
  const filled: SlotValues = {};
  for (const slot of template.slots) {
    // The user picks every person: a contact gap may only start out as "anyone".
    const fallback = slot.kind === 'contact' && slot.default !== 'any' ? undefined : slot.default;
    const value = values[slot.name] ?? fallback;
    const problem = checkSlotValue(slot, value);
    if (problem) errors.push(problem);
    else filled[slot.name] = typeof value === 'string' ? value.trim() : value!;
  }
  if (errors.length) return { ok: false, errors };

  const draft = substitute(template.rule, filled) as Record<string, unknown>;
  return validateRule({
    ...draft,
    id: options.id ?? randomId(),
    enabled: true,
    source: options.source ?? 'template',
    templateId: template.id,
  });
}

const contactSlot = (allowAny = false): SlotDef => ({ name: 'contact', kind: 'contact', label: 'Person', allowAny });

/** Ready-made automations covering the examples from the plan. All text is German UI copy. */
export const BUILTIN_TEMPLATES: RuleTemplate[] = [
  {
    id: 'core.arrival-alert',
    title: 'Ankunft melden',
    sentence: 'Sag mir Bescheid, wenn {contact} bei {place} ankommt',
    category: 'ankunft',
    slots: [contactSlot(true), { name: 'place', kind: 'place_name', label: 'Ort', default: 'Zuhause' }],
    rule: {
      name: 'Ankunft: {{slot:place}}',
      trigger: { on: 'contact.arrive', contact: '{{slot:contact}}', place: '{{slot:place}}' },
      conditions: [],
      actions: [{ do: 'notify', title: '{{contact}} ist da', body: '{{contact}} ist bei {{place}} angekommen.' }],
    },
  },
  {
    id: 'core.almost-there',
    title: 'Gleich da',
    sentence: 'Melde dich, wenn {contact} weniger als {minutes} Minuten entfernt ist',
    category: 'unterwegs',
    slots: [contactSlot(true), { name: 'minutes', kind: 'minutes', label: 'Minuten', default: 5 }],
    rule: {
      name: 'Gleich da',
      trigger: { on: 'contact.eta_below', contact: '{{slot:contact}}', minutes: '{{slot:minutes}}' },
      conditions: [],
      actions: [{ do: 'notify', title: '{{contact}} ist gleich da', body: '{{contact}} kommt {{eta}} an.' }],
    },
  },
  {
    id: 'core.trip-start',
    title: 'Losgefahren',
    sentence: 'Sag mir Bescheid, wenn {contact} losfährt',
    category: 'unterwegs',
    slots: [contactSlot(true)],
    rule: {
      name: 'Losgefahren',
      trigger: { on: 'contact.trip_start', contact: '{{slot:contact}}' },
      conditions: [],
      actions: [{ do: 'notify', title: '{{contact}} ist unterwegs', body: 'Ziel: {{destination}}' }],
    },
  },
  {
    id: 'core.shopping-help',
    title: 'Beim Tragen helfen',
    sentence: 'Wenn {contact} {place} verlässt, erinnere mich ans Tragen helfen',
    category: 'alltag',
    slots: [contactSlot(), { name: 'place', kind: 'place_name', label: 'Laden', default: 'Supermarkt' }],
    rule: {
      name: 'Einkauf tragen',
      trigger: { on: 'contact.leave', contact: '{{slot:contact}}', place: '{{slot:place}}' },
      conditions: [],
      actions: [
        {
          do: 'notify',
          title: 'Einkauf ist unterwegs 🛍️',
          body: '{{contact}} hat {{place}} verlassen. Gleich beim Tragen helfen?',
        },
      ],
    },
  },
  {
    id: 'core.home-safe',
    title: 'Gut angekommen',
    sentence: 'Wenn ich bei {myplace} ankomme, melde {contact} „gut angekommen“',
    category: 'sicherheit',
    slots: [{ name: 'myplace', kind: 'my_place', label: 'Mein Ort' }, contactSlot()],
    rule: {
      name: 'Gut angekommen',
      trigger: { on: 'me.arrive', place: '{{slot:myplace}}' },
      conditions: [],
      actions: [{ do: 'send_checkin', to: ['{{slot:contact}}'], kind: 'arrived', text: 'Bin gut bei {{place}} angekommen ✅' }],
    },
  },
  {
    id: 'core.share-on-leave',
    title: 'Heimweg teilen',
    sentence: 'Wenn ich {from} verlasse, teile meine Ankunftszeit nach {to} mit {contact}',
    category: 'unterwegs',
    slots: [
      { name: 'from', kind: 'my_place', label: 'Start' },
      { name: 'to', kind: 'my_place', label: 'Ziel' },
      contactSlot(),
    ],
    rule: {
      name: 'Heimweg teilen',
      trigger: { on: 'me.leave', place: '{{slot:from}}' },
      conditions: [],
      actions: [{ do: 'start_trip', to: ['{{slot:contact}}'], destination: '{{slot:to}}', level: 'eta' }],
    },
  },
  {
    id: 'core.pickup-alert',
    title: 'Abhol-Bitte',
    sentence: 'Wecke mich auf, wenn {contact} abgeholt werden möchte',
    category: 'sicherheit',
    slots: [contactSlot(true)],
    rule: {
      name: 'Abhol-Bitte',
      trigger: { on: 'contact.ping', contact: '{{slot:contact}}', kind: 'pickup-request' },
      conditions: [],
      actions: [{ do: 'notify', title: '{{contact}} möchte abgeholt werden', body: '{{text}}' }],
    },
  },
  {
    id: 'core.travel-arrived',
    title: 'Am Urlaubsort angekommen',
    sentence: 'Wenn ich in {myplace} ankomme, sag {contact} Bescheid, dass alles gut ist',
    category: 'reise',
    slots: [{ name: 'myplace', kind: 'my_place', label: 'Reiseziel' }, contactSlot()],
    rule: {
      name: 'Gut am Reiseziel',
      trigger: { on: 'me.arrive', place: '{{slot:myplace}}' },
      conditions: [],
      actions: [{ do: 'send_checkin', to: ['{{slot:contact}}'], kind: 'arrived', text: 'Bin gut in {{place}} angekommen ✈️' }],
    },
  },
  {
    id: 'core.home-status',
    title: 'Zuhause-Status',
    sentence: 'Wenn ich nach {myplace} komme, zeige meinen Status „Zuhause 🏠“',
    category: 'familie',
    slots: [{ name: 'myplace', kind: 'my_place', label: 'Zuhause' }],
    rule: {
      name: 'Status: Zuhause',
      trigger: { on: 'me.arrive', place: '{{slot:myplace}}' },
      conditions: [],
      actions: [{ do: 'set_status', text: 'Zuhause', emoji: '🏠', hours: 12 }],
    },
  },
  {
    id: 'core.home-family',
    title: 'Zuhause angekommen',
    sentence: 'Wenn ich nach {myplace} komme, melde {contact} „bin zuhause“',
    category: 'familie',
    slots: [{ name: 'myplace', kind: 'my_place', label: 'Zuhause' }, contactSlot()],
    rule: {
      name: 'Bin zuhause',
      trigger: { on: 'me.arrive', place: '{{slot:myplace}}' },
      conditions: [],
      actions: [{ do: 'send_checkin', to: ['{{slot:contact}}'], kind: 'home' }],
    },
  },
  {
    id: 'core.quiet-at-place',
    title: 'Ruhe bei der Arbeit',
    sentence: 'Wenn ich bei {myplace} ankomme, schalte den Ruhemodus für {duration} an',
    category: 'ruhe',
    slots: [
      { name: 'myplace', kind: 'my_place', label: 'Ort' },
      { name: 'duration', kind: 'duration', label: 'Dauer', default: 480 },
    ],
    rule: {
      name: 'Ruhemodus bei {{slot:myplace}}',
      trigger: { on: 'me.arrive', place: '{{slot:myplace}}' },
      conditions: [],
      actions: [{ do: 'set_dnd', minutes: '{{slot:duration}}' }],
    },
  },
  {
    id: 'core.quiet-off-leave',
    title: 'Ruhe aus beim Gehen',
    sentence: 'Wenn ich {myplace} verlasse, schalte den Ruhemodus aus',
    category: 'ruhe',
    slots: [{ name: 'myplace', kind: 'my_place', label: 'Ort' }],
    rule: {
      name: 'Ruhemodus aus',
      trigger: { on: 'me.leave', place: '{{slot:myplace}}' },
      conditions: [],
      actions: [{ do: 'set_dnd', minutes: 0 }],
    },
  },
  {
    id: 'core.see-you-soon',
    title: 'Bis gleich!',
    sentence: 'Wenn {contact} „bin unterwegs“ schickt, antworte „Bis gleich! 👋“',
    category: 'freunde',
    slots: [contactSlot(true)],
    rule: {
      name: 'Bis gleich',
      trigger: { on: 'contact.ping', contact: '{{slot:contact}}', kind: 'on-my-way' },
      conditions: [],
      actions: [{ do: 'notify', title: '{{contact}} ist unterwegs zu dir', body: 'Mach dich bereit 🙂' }],
    },
  },
  {
    id: 'core.checkin-heart',
    title: 'Herz zurück',
    sentence: 'Wenn {contact} „gut angekommen“ meldet, schicke ein Herz zurück',
    category: 'freunde',
    slots: [contactSlot()],
    rule: {
      name: 'Herz bei Ankunft',
      trigger: { on: 'contact.checkin', contact: '{{slot:contact}}' },
      conditions: [],
      actions: [{ do: 'send_ping', to: '{{slot:contact}}', kind: 'thinking-of-you' }],
    },
  },
  {
    id: 'core.sos-forward',
    title: 'Notruf weitersagen',
    sentence: 'Wenn {contact} einen Notruf sendet, schreibe auch {other}',
    category: 'sicherheit',
    slots: [contactSlot(true), { name: 'other', kind: 'contact', label: 'Wem noch' }],
    rule: {
      name: 'Notruf weitersagen',
      trigger: { on: 'contact.sos', contact: '{{slot:contact}}' },
      conditions: [],
      actions: [{ do: 'send_message', to: '{{slot:other}}', text: '🆘 {{contact}} hat in Heyda. einen Notruf ausgelöst. Bitte melde dich bei mir!' }],
    },
  },
  {
    id: 'core.late-evening',
    title: 'Spät unterwegs',
    sentence: 'Wenn {contact} abends nach 22 Uhr losfährt, sag mir Bescheid',
    category: 'familie',
    slots: [contactSlot(true)],
    rule: {
      name: 'Spät unterwegs',
      trigger: { on: 'contact.trip_start', contact: '{{slot:contact}}' },
      conditions: [{ if: 'time_between', from: '22:00', to: '06:00' }],
      actions: [{ do: 'notify', title: '{{contact}} ist noch unterwegs', body: 'Ziel: {{destination}}' }],
    },
  },
];
