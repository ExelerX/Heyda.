import { contactLabel, type NodeState, type RuleTemplate, type SlotDef, type SlotValues } from '@heyda/core';

export const CATEGORY_TEXT: Record<RuleTemplate['category'], string> = {
  ankunft: 'Ankommen',
  unterwegs: 'Unterwegs',
  reise: 'Reise',
  sicherheit: 'Sicherheit',
  familie: 'Familie',
  freunde: 'Freunde',
  ruhe: 'Ruhe',
  alltag: 'Alltag',
};

export const CATEGORY_ICON: Record<RuleTemplate['category'], string> = {
  ankunft: '📍',
  unterwegs: '🚗',
  reise: '✈️',
  sicherheit: '🛟',
  familie: '🏠',
  freunde: '💛',
  ruhe: '🌙',
  alltag: '🛍️',
};

/** Extra words people might type into the command search. */
const SYNONYMS: Record<string, string[]> = {
  ankunft: ['da', 'angekommen', 'ankommen', 'zuhause', 'heim'],
  unterwegs: ['eta', 'fahrt', 'weg', 'minuten', 'gleich', 'losfahren', 'auto', 'bus'],
  reise: ['urlaub', 'flug', 'hotel', 'ferien', 'angekommen'],
  sicherheit: ['sicher', 'abholen', 'notfall', 'sos', 'gut angekommen', 'kind'],
  familie: ['eltern', 'kinder', 'zuhause', 'oma', 'opa'],
  freunde: ['herz', 'antwort', 'bis gleich'],
  ruhe: ['nicht stören', 'stumm', 'arbeit', 'schlafen', 'dnd', 'leise'],
  alltag: ['einkauf', 'laden', 'supermarkt', 'tragen', 'helfen', 'shopping'],
};

/** "30 Min.", "1 Std.", "1 Std. 30 Min." */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} Min.`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

/** How a chosen slot value reads in the sentence, or undefined while it is not chosen. */
export function slotValueText(slot: SlotDef, v: string | number | undefined, state: NodeState): string | undefined {
  if (v === undefined || v === '') return undefined;
  switch (slot.kind) {
    case 'contact': {
      if (v === 'any') return 'jemand';
      const c = state.contacts.find((x) => x.key === v);
      return c ? contactLabel(c) : '?';
    }
    case 'my_place':
      return state.places.find((p) => p.id === v)?.name ?? '?';
    case 'duration':
      return typeof v === 'number' ? durationLabel(v) : String(v);
    case 'minutes':
      return typeof v === 'number' ? `${v}` : String(v);
    default:
      return String(v).trim() || undefined;
  }
}

export interface SentencePart {
  text: string;
  /** Set for a gap; `filled` tells whether the user already chose something. */
  slot?: SlotDef;
  filled?: boolean;
}

/** Splits a template sentence into plain text and gaps, so gaps can be styled. */
export function sentenceParts(template: RuleTemplate, values: SlotValues = {}, state?: NodeState): SentencePart[] {
  const parts: SentencePart[] = [];
  const re = /\{([a-z][a-z0-9_]*)\}/g;
  let last = 0;
  for (const m of template.sentence.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: template.sentence.slice(last, at) });
    const slot = template.slots.find((s) => s.name === m[1]);
    const shown = slot && state ? slotValueText(slot, values[slot.name], state) : undefined;
    parts.push({ text: shown ?? slot?.label ?? m[1] ?? '', slot, filled: shown !== undefined });
    last = at + m[0].length;
  }
  if (last < template.sentence.length) parts.push({ text: template.sentence.slice(last) });
  return parts;
}

/** Fills a template sentence: chosen values where set, the slot's label in brackets otherwise. */
export function fillSentence(template: RuleTemplate, values: SlotValues, state: NodeState): string {
  return sentenceParts(template, values, state)
    .map((p) => (p.slot && !p.filled ? `[${p.text}]` : p.text))
    .join('');
}

export function matchesSearch(template: RuleTemplate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [template.title, template.sentence, CATEGORY_TEXT[template.category], ...(SYNONYMS[template.category] ?? [])]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/** Templates from a plugin (built-in ones start with "core."). */
export function isPluginTemplate(template: RuleTemplate): boolean {
  return !template.id.startsWith('core.');
}

/** What a template needs before it can be filled in. */
export function templateNeeds(template: RuleTemplate): { contacts: boolean; places: number } {
  return {
    contacts: template.slots.some((s) => s.kind === 'contact' && !s.allowAny),
    places: template.slots.filter((s) => s.kind === 'my_place').length,
  };
}

/** Templates matching the search (and category, if any), grouped by category in a fixed order. */
export function groupTemplates(
  templates: RuleTemplate[],
  query: string,
  category?: RuleTemplate['category'],
): { category: RuleTemplate['category']; label: string; items: RuleTemplate[] }[] {
  const found = templates.filter((t) => matchesSearch(t, query) && (!category || t.category === category));
  return (Object.keys(CATEGORY_TEXT) as RuleTemplate['category'][])
    .map((c) => ({ category: c, label: CATEGORY_TEXT[c], items: found.filter((t) => t.category === c) }))
    .filter((g) => g.items.length > 0);
}

export const TIPS = [
  'Tippe auf „Gleich da“, damit du rechtzeitig die Tür aufmachst.',
  '„Heimweg teilen“ startet das Teilen automatisch, sobald du die Arbeit verlässt. Immer nur als Ankunftszeit.',
  'Mit „Ruhe bei der Arbeit“ schaltet sich „Bitte nicht stören“ von selbst an und aus.',
  'Plugins sind nur Vorlagen. Wen sie betreffen, wählst immer du aus.',
  'Mit dem Geistmodus pausierst du jedes automatische Teilen auf einmal. Ein Notruf geht trotzdem raus.',
  'Jede Automation darf höchstens 20-mal pro Stunde auslösen. So nervt nichts.',
  'Automationen, die auf Freunde reagieren, brauchen deren Freigabe: Ankunft an einem Ort siehst du nur, wenn sie dir den Ort freigeben.',
  'Mit „Und nur wenn“ grenzt du eine Automation ein, z. B. nur werktags oder nur abends.',
];
