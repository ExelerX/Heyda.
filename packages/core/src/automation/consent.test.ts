import { describe, expect, it } from 'vitest';
import { describeRule } from './describe';
import { AutomationEngine } from './engine';
import { importPlugin, storedPlugins, type Plugin } from './plugin';
import type { Rule } from './schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './templates';

/**
 * What the user agrees to must be what an automation does: the sentence shows every text that
 * leaves the phone, a plugin can never pick a person by itself, and a name I gave someone only
 * for me never goes to others. Each test first reproduced the problem before it was fixed.
 */

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const MALLORY = '3'.repeat(64);
const OMA = '4'.repeat(64);

/** How I see people (my nickname for Oma) and the names they chose. */
const mine: Record<string, string> = { [LISA]: 'Lisa', [MAX]: 'Max', [MALLORY]: 'Mallory', [OMA]: 'Drachen-Oma' };
const theirs: Record<string, string> = { [LISA]: 'Lisa', [MAX]: 'Max', [MALLORY]: 'Mallory', [OMA]: 'Oma Ilse' };
const names = {
  contactName: (k: string) => mine[k] ?? '?',
  sentName: (k: string) => theirs[k] ?? '?',
  placeName: (id: string) => id,
};

function plugin(template: Record<string, unknown>) {
  return JSON.stringify({
    format: 'heyda.plugin',
    version: 1,
    id: 'evil.helper',
    name: 'Familien-Helfer',
    description: 'Hilft der Familie.',
    author: 'M',
    templates: [{ id: 'evil.helper.one', title: 'Helfer', category: 'familie', sentence: 'Hilft {who}', ...template }],
  });
}

const forwardChats = {
  slots: [
    { name: 'who', kind: 'contact', label: 'Person', allowAny: true, default: 'any' },
    { name: 'partner', kind: 'contact', label: 'Partner' },
  ],
  rule: {
    name: 'Unterwegs',
    trigger: { on: 'contact.message', contact: '{{slot:who}}' },
    conditions: [],
    actions: [{ do: 'send_ping', to: '{{slot:partner}}', kind: 'on-my-way', text: '{{contact}}: {{text}}' }],
  },
};

describe('the sentence shows every text an automation sends', () => {
  it('shows the own text of a ping of any kind, not just its label', () => {
    const imp = importPlugin(plugin(forwardChats));
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const r = instantiateTemplate(imp.plugin.templates[0]!, { who: 'any', partner: MALLORY }, { source: 'plugin' });
    if (!r.ok) throw new Error(r.errors.join());
    // What Mallory gets is "🚶 Max: <the message>", so that is what the sentence has to say.
    expect(describeRule(r.value, names)).toBe('Wenn jemand schreibt: Schicke Mallory „🚶 [Person]: [Nachricht]“.');
  });

  it('fills in what my status will say, which every contact sees', () => {
    const r = importPlugin(
      plugin({
        slots: [{ name: 'who', kind: 'contact', label: 'Person', allowAny: true, default: 'any' }],
        rule: {
          name: 'Status',
          trigger: { on: 'contact.message', contact: '{{slot:who}}' },
          conditions: [],
          actions: [{ do: 'set_status', text: '{{contact}}: {{text}}', emoji: '💬', hours: 1 }],
        },
      }),
    );
    if (!r.ok) throw new Error(r.errors.join());
    const rule = instantiateTemplate(r.plugin.templates[0]!, { who: 'any' }, { source: 'plugin' });
    if (!rule.ok) throw new Error(rule.errors.join());
    expect(describeRule(rule.value, names)).toBe('Wenn jemand schreibt: Setze deinen Status auf „💬 [Person]: [Nachricht]“.');
  });

  it('still shows the label of a ping without its own text', () => {
    const r = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === 'core.checkin-heart')!, { contact: MAX });
    if (!r.ok) throw new Error(r.errors.join());
    expect(describeRule(r.value, names)).toBe('Wenn Max sich meldet: Schicke Max „Denk an dich ❤️“.');
  });
});

describe('a plugin can never pick a person by itself', () => {
  it('refuses a person filled in ahead in a contact gap', () => {
    const t = structuredClone(forwardChats);
    (t.slots[1] as Record<string, unknown>).default = MALLORY;
    const r = importPlugin(plugin(t));
    expect(r.ok).toBe(false);
  });

  it('refuses a person hidden in the default of a text gap', () => {
    const r = importPlugin(
      plugin({
        slots: [
          { name: 'who', kind: 'contact', label: 'Person', allowAny: true, default: 'any' },
          { name: 'note', kind: 'text', label: 'Notiz', default: MALLORY },
        ],
        rule: {
          name: 'Notiz',
          trigger: { on: 'contact.message', contact: '{{slot:who}}' },
          conditions: [],
          actions: [{ do: 'send_message', to: '{{slot:note}}', text: '{{contact}}: {{text}}' }],
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('refuses a key in any gap default, just like anywhere in the rule itself', () => {
    const r = importPlugin(
      plugin({
        slots: [
          { name: 'who', kind: 'contact', label: 'Person', allowAny: true, default: 'any' },
          { name: 'note', kind: 'text', label: 'Notiz', default: `Grüße an ${MALLORY}` },
        ],
        rule: {
          name: 'Notiz',
          trigger: { on: 'contact.message', contact: '{{slot:who}}' },
          conditions: [],
          actions: [{ do: 'notify', title: 'Neu', body: '{{slot:note}}' }],
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('refuses a person put together from two gaps', () => {
    const r = importPlugin(
      plugin({
        slots: [
          { name: 'who', kind: 'contact', label: 'Person', allowAny: true, default: 'any' },
          { name: 'a', kind: 'text', label: 'Teil 1', default: '3'.repeat(32) },
          { name: 'b', kind: 'text', label: 'Teil 2', default: '3'.repeat(32) },
        ],
        rule: {
          name: 'Teile',
          trigger: { on: 'contact.message', contact: '{{slot:who}}' },
          conditions: [],
          actions: [{ do: 'send_message', to: '{{slot:a}}{{slot:b}}', text: '{{text}}' }],
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('refuses gaps that decide what happens or when, so the list of what it may do stays true', () => {
    const r = importPlugin(
      plugin({
        slots: [
          { name: 'when', kind: 'text', label: 'Wann', default: 'me.leave' },
          { name: 'what', kind: 'text', label: 'Was', default: 'start_trip' },
          { name: 'place', kind: 'my_place', label: 'Ort', default: 'home' },
          { name: 'contact', kind: 'contact', label: 'Person' },
        ],
        rule: {
          name: 'Erinnerung',
          trigger: { on: '{{slot:when}}', place: '{{slot:place}}' },
          conditions: [],
          actions: [{ do: '{{slot:what}}', to: ['{{slot:contact}}'], destination: '{{slot:place}}', level: 'eta' }],
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('a plugin saved before these checks cannot pick a person either', () => {
    const imp = importPlugin(plugin(forwardChats));
    if (!imp.ok) throw new Error(imp.errors.join());
    // As an older version saved it: the partner filled in ahead.
    const old = structuredClone(imp.plugin) as Plugin;
    old.templates[0]!.slots[1]!.default = MALLORY;
    // Not used when filling in the template, so nobody is picked without the user...
    const r = instantiateTemplate(old.templates[0]!, { who: 'any' });
    expect(r.ok).toBe(false);
    // ...and dropped when the app loads its saved plugins or restores a backup.
    expect(storedPlugins([old, imp.plugin, { junk: true }, 'x']).map((p) => p.templates[0]!.slots[1]!.default)).toEqual([undefined]);
  });

  it('still takes "anyone" filled in ahead, and people the user picks', () => {
    const r = importPlugin(plugin(forwardChats));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.capabilities.sort()).toEqual(['react_to_contacts', 'send_message']);
  });
});

describe('my nickname for someone stays mine', () => {
  const sosForward = (): Rule => {
    const r = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === 'core.sos-forward')!, { contact: OMA, other: MAX });
    if (!r.ok) throw new Error(r.errors.join());
    return r.value;
  };

  it('messages to others use the name the person chose; my own notifications use my nickname', () => {
    const notify: Rule = {
      id: 'notify-rule-1',
      name: 'Notruf zeigen',
      enabled: true,
      trigger: { on: 'contact.sos', contact: OMA },
      conditions: [],
      actions: [{ do: 'notify', title: '{{contact}} braucht Hilfe', body: 'Schnell!' }],
      source: 'manual',
    };
    const engine = new AutomationEngine({
      rules: () => [sosForward(), notify],
      contactName: names.contactName,
      sentName: names.sentName,
      placeName: () => undefined,
      isAtPlace: () => false,
    });
    const out = engine.handle({ type: 'contact.sos', contact: OMA, at: 1000 });
    const sent = out.find((i) => i.kind === 'send_message');
    expect(sent && sent.kind === 'send_message' && sent.text).toBe('🆘 Oma Ilse hat in Heyda. einen Notruf ausgelöst. Bitte melde dich bei mir!');
    const shown = out.find((i) => i.kind === 'notify');
    expect(shown && shown.kind === 'notify' && shown.title).toBe('Drachen-Oma braucht Hilfe');
  });

  it('the sentence shows the name that will go out', () => {
    expect(describeRule(sosForward(), names)).toBe(
      'Wenn Drachen-Oma einen Notruf sendet: Schreibe Max „🆘 Oma Ilse hat in Heyda. einen Notruf ausgelöst. Bitte melde dich bei mir!“.',
    );
  });
});
