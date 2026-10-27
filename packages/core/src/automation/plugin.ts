import { z } from 'zod';
import { RuleTemplate, instantiateTemplate, placeholdersIn } from './templates';
import type { Action, Rule, Trigger } from './schema';

/**
 * A plugin is a shareable bundle of templates, as a JSON file or QR code.
 * It contains no executable code, so importing one cannot do anything the
 * template sentences do not say. Contacts and places are always gaps the
 * importing user fills in; a plugin can never point at someone by itself.
 */
export const Plugin = z.strictObject({
  format: z.literal('heyda.plugin'),
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/).max(120),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300),
  author: z.string().trim().min(1).max(60),
  templates: z.array(RuleTemplate).min(1).max(20),
});
export type Plugin = z.infer<typeof Plugin>;

export const MAX_PLUGIN_BYTES = 64 * 1024;

export type PluginCapability =
  | 'notify'
  | 'send_message'
  | 'start_sharing'
  | 'change_settings'
  | 'react_to_contacts'
  | 'react_to_my_places';

/** Short German explanations for the import consent screen. */
export const CAPABILITY_TEXT: Record<PluginCapability, string> = {
  notify: 'Benachrichtigungen auf diesem Handy anzeigen',
  send_message: 'In deinem Namen kurze Nachrichten an gewählte Kontakte senden',
  start_sharing: 'Das Teilen deiner Ankunftszeit starten (nur Stufe „ETA“)',
  change_settings: 'Deinen Ruhemodus oder Status ändern',
  react_to_contacts: 'Auf Ereignisse reagieren, die deine Kontakte mit dir teilen',
  react_to_my_places: 'Auf deine Ankunft und Abfahrt an deinen Orten reagieren',
};

export type ImportResult =
  | { ok: true; plugin: Plugin; capabilities: PluginCapability[] }
  | { ok: false; errors: string[] };

export function importPlugin(raw: string): ImportResult {
  if (new TextEncoder().encode(raw).length > MAX_PLUGIN_BYTES) return { ok: false, errors: ['Datei zu groß'] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['Keine gültige Plugin-Datei'] };
  }
  const parsed = Plugin.safeParse(json);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const plugin = parsed.data;
  const errors: string[] = [];

  for (const t of plugin.templates) {
    if (!t.id.startsWith(`${plugin.id}.`)) errors.push(`${t.id}: Vorlagen-ID muss mit ${plugin.id}. beginnen`);
    if (containsConcreteKey(t.rule) || containsConcreteKey(t.slots.map((s) => s.default))) {
      errors.push(`${t.id}: darf keine festen Kontakte enthalten`);
    }
    for (const s of t.slots) {
      // The importing user picks every person; only "anyone" may be filled in ahead.
      if (s.kind === 'contact' && s.default !== undefined && !(s.default === 'any' && s.allowAny)) {
        errors.push(`${t.id}: ${s.label} darf nicht vorausgewählt sein`);
      }
    }
    // What happens and when must stand in the plugin itself, so the list of what it may do is true.
    const structural = [t.rule.trigger.on, ...t.rule.conditions.map((c) => c.if), ...t.rule.actions.map((a) => a.do)];
    if (structural.some((v) => typeof v === 'string' && placeholdersIn(v).size > 0)) {
      errors.push(`${t.id}: Auslöser, Bedingungen und Aktionen dürfen keine Lücken sein`);
    }

    const declared = new Set(t.slots.map((s) => s.name));
    for (const used of placeholdersIn(t.rule)) {
      if (!declared.has(used)) errors.push(`${t.id}: unbekannte Lücke {{slot:${used}}}`);
    }
    // Prove the template produces a valid rule, using harmless sample values, and that every
    // person in it is one the user picks in a contact gap.
    const values = sampleValues(t);
    const sample = instantiateTemplate(t, values);
    if (!sample.ok) errors.push(...sample.errors.map((e) => `${t.id}: ${e}`));
    else {
      const picked = new Set(t.slots.filter((s) => s.kind === 'contact').map((s) => values[s.name]));
      if (contactRefs(sample.value).some((k) => k !== 'any' && !picked.has(k))) {
        errors.push(`${t.id}: darf keine festen Kontakte enthalten`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, plugin, capabilities: capabilitiesOf(plugin) };
}

/**
 * Plugins as saved by the app or in a backup, checked again like a fresh import: one saved by an
 * older version, before a check existed, is dropped instead of offering its templates.
 */
export function storedPlugins(list: unknown): Plugin[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => {
    try {
      const r = importPlugin(JSON.stringify(p));
      return r.ok ? [r.plugin] : [];
    } catch {
      return [];
    }
  });
}

export function capabilitiesOf(plugin: Plugin): PluginCapability[] {
  const caps = new Set<PluginCapability>();
  for (const t of plugin.templates) {
    const on = String((t.rule.trigger as Partial<Trigger>).on ?? '');
    caps.add(on.startsWith('me.') ? 'react_to_my_places' : 'react_to_contacts');
    for (const a of t.rule.actions as Partial<Action>[]) {
      if (a.do === 'notify') caps.add('notify');
      if (a.do === 'send_ping' || a.do === 'send_message' || a.do === 'send_checkin') caps.add('send_message');
      if (a.do === 'set_dnd' || a.do === 'set_status') caps.add('change_settings');
      if (a.do === 'start_trip') caps.add('start_sharing');
    }
  }
  return [...caps];
}

function containsConcreteKey(node: unknown): boolean {
  if (typeof node === 'string') return /[0-9a-f]{64}/.test(node);
  if (Array.isArray(node)) return node.some(containsConcreteKey);
  if (node && typeof node === 'object') return Object.values(node).some(containsConcreteKey);
  return false;
}

/** Everyone a rule reacts to or reaches. */
function contactRefs(rule: Rule): string[] {
  const refs: string[] = 'contact' in rule.trigger ? [rule.trigger.contact] : [];
  for (const a of rule.actions) {
    if ('to' in a) refs.push(...(Array.isArray(a.to) ? a.to : [a.to]));
  }
  return refs;
}

/** A different made-up person for each contact gap (64 hex digits, never a real key in practice). */
const sampleKey = (i: number) => `${(0xa0 + i).toString(16)}${'e'.repeat(62)}`;

function sampleValues(t: RuleTemplate): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  t.slots.forEach((s, i) => {
    values[s.name] =
      s.kind === 'contact'
        ? s.default === 'any' && s.allowAny
          ? 'any'
          : sampleKey(i)
        : (s.default ?? { minutes: 5, duration: 60, my_place: 'sample', place_name: 'Beispiel', text: 'Beispiel' }[s.kind]);
  });
  return values;
}
