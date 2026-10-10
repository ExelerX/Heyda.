import { z } from 'zod';
import { RuleTemplate, instantiateTemplate, placeholdersIn } from './templates';
import type { Action, Trigger } from './schema';

/**
 * A plugin is a shareable bundle of templates, as a JSON file or QR code.
 * It contains no executable code, so importing one cannot do anything the
 * template sentences do not say. Contacts and places are always gaps the
 * importing user fills in; a plugin can never point at someone by itself.
 */
export const Plugin = z.strictObject({
  format: z.literal('fastda.plugin'),
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
  | 'react_to_contacts'
  | 'react_to_my_places';

/** Short German explanations for the import consent screen. */
export const CAPABILITY_TEXT: Record<PluginCapability, string> = {
  notify: 'Benachrichtigungen auf diesem Handy anzeigen',
  send_message: 'In deinem Namen kurze Nachrichten an gewählte Kontakte senden',
  start_sharing: 'Das Teilen deiner Ankunftszeit starten (nur Stufe „ETA“)',
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
    if (containsConcreteKey(t.rule)) errors.push(`${t.id}: darf keine festen Kontakte enthalten`);

    const declared = new Set(t.slots.map((s) => s.name));
    for (const used of placeholdersIn(t.rule)) {
      if (!declared.has(used)) errors.push(`${t.id}: unbekannte Lücke {{slot:${used}}}`);
    }
    // Prove the template produces a valid rule, using harmless sample values.
    const sample = instantiateTemplate(t, sampleValues(t));
    if (!sample.ok) errors.push(...sample.errors.map((e) => `${t.id}: ${e}`));
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, plugin, capabilities: capabilitiesOf(plugin) };
}

export function capabilitiesOf(plugin: Plugin): PluginCapability[] {
  const caps = new Set<PluginCapability>();
  for (const t of plugin.templates) {
    const on = String((t.rule.trigger as Partial<Trigger>).on ?? '');
    caps.add(on.startsWith('me.') ? 'react_to_my_places' : 'react_to_contacts');
    for (const a of t.rule.actions as Partial<Action>[]) {
      if (a.do === 'notify') caps.add('notify');
      if (a.do === 'send_ping') caps.add('send_message');
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

const SAMPLE_KEY = 'f'.repeat(64);

function sampleValues(t: RuleTemplate): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const s of t.slots) {
    values[s.name] =
      s.default ??
      { contact: SAMPLE_KEY, minutes: 5, my_place: 'sample', place_name: 'Beispiel', text: 'Beispiel' }[s.kind];
  }
  return values;
}
