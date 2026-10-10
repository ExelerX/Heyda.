import { z } from 'zod';
import { randomId } from '../util/random';
import { validateRule, type Rule, type RuleSource, type ValidateResult } from './schema';

/**
 * A no-code automation: a sentence with gaps the user fills in by tapping,
 * e.g. "Tell me when {contact} arrives at {place}".
 * The rule inside uses `{{slot:name}}` placeholders that get replaced by the choices.
 */
export const SlotKind = z.enum(['contact', 'place_name', 'my_place', 'minutes', 'text']);
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
  category: z.enum(['ankunft', 'unterwegs', 'sicherheit', 'alltag']),
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
    const value = values[slot.name] ?? slot.default;
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
    sentence: 'Wenn ich bei {myplace} ankomme, sag {contact} Bescheid',
    category: 'sicherheit',
    slots: [{ name: 'myplace', kind: 'my_place', label: 'Mein Ort' }, contactSlot()],
    rule: {
      name: 'Gut angekommen',
      trigger: { on: 'me.arrive', place: '{{slot:myplace}}' },
      conditions: [],
      actions: [{ do: 'send_ping', to: '{{slot:contact}}', kind: 'custom', text: 'Bin gut bei {{place}} angekommen ✅' }],
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
];
