import type { NodeState, RuleTemplate, SlotValues } from '@social-app/core';

export const CATEGORY_TEXT: Record<RuleTemplate['category'], string> = {
  ankunft: 'Ankommen',
  unterwegs: 'Unterwegs',
  sicherheit: 'Sicherheit',
  alltag: 'Alltag',
};

/** Extra words people might type into the command search. */
const SYNONYMS: Record<string, string[]> = {
  ankunft: ['da', 'angekommen', 'ankommen', 'zuhause', 'heim'],
  unterwegs: ['eta', 'fahrt', 'weg', 'minuten', 'gleich', 'losfahren', 'auto', 'bus'],
  sicherheit: ['sicher', 'abholen', 'notfall', 'gut angekommen', 'kind'],
  alltag: ['einkauf', 'laden', 'supermarkt', 'tragen', 'helfen', 'shopping'],
};

/** Fills a template sentence: chosen values where set, the slot's label in brackets otherwise. */
export function fillSentence(template: RuleTemplate, values: SlotValues, state: NodeState): string {
  return template.sentence.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, name: string) => {
    const slot = template.slots.find((s) => s.name === name);
    const v = values[name];
    if (!slot || v === undefined || v === '') return `[${slot?.label ?? name}]`;
    if (slot.kind === 'contact') return v === 'any' ? 'jemand' : state.contacts.find((c) => c.key === v)?.name ?? '?';
    if (slot.kind === 'my_place') return state.places.find((p) => p.id === v)?.name ?? '?';
    return String(v);
  });
}

export function matchesSearch(template: RuleTemplate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [template.title, template.sentence, CATEGORY_TEXT[template.category], ...(SYNONYMS[template.category] ?? [])]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

export const TIPS = [
  'Tippe auf „Gleich da“, damit du rechtzeitig die Tür aufmachst.',
  '„Heimweg teilen“ startet das Teilen automatisch, sobald du die Arbeit verlässt. Immer nur als Ankunftszeit.',
  'Plugins sind nur Vorlagen. Wen sie betreffen, wählst immer du aus.',
  'Mit dem Geistermodus auf der Startseite pausierst du alles auf einmal.',
  'Jede Automation darf höchstens 20-mal pro Stunde auslösen. So nervt nichts.',
];
