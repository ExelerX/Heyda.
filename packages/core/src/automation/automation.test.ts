import { describe, expect, it } from 'vitest';
import { describeRule } from './describe';
import { AutomationEngine, render, type AutomationEvent } from './engine';
import { importPlugin } from './plugin';
import { validateRule, type Rule } from './schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './templates';

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const names = { [LISA]: 'Lisa', [MAX]: 'Max' } as Record<string, string>;

function engineWith(rules: Rule[], opts: { atPlace?: string[]; minutes?: number; weekday?: number } = {}) {
  return new AutomationEngine({
    rules: () => rules,
    contactName: (k) => names[k] ?? '?',
    placeName: (id) => ({ home: 'Zuhause', work: 'Arbeit' })[id],
    isAtPlace: (id) => opts.atPlace?.includes(id) ?? false,
    localTime: () => ({ minutes: opts.minutes ?? 12 * 60, weekday: opts.weekday ?? 3 }),
  });
}

const template = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id)!;

function fromTemplate(id: string, values: Record<string, string | number>): Rule {
  const r = instantiateTemplate(template(id), values);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}

describe('templates', () => {
  it('every built-in template produces a valid rule with its defaults plus contacts and places', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const values: Record<string, string | number> = {};
      for (const s of t.slots) {
        if (s.kind === 'contact') values[s.name] = LISA;
        if (s.kind === 'my_place') values[s.name] = 'home';
      }
      const r = instantiateTemplate(t, values);
      expect(r.ok, `${t.id}: ${!r.ok ? r.errors.join(', ') : ''}`).toBe(true);
    }
  });

  it('fills numbers as numbers', () => {
    const rule = fromTemplate('core.almost-there', { contact: LISA, minutes: 3 });
    expect(rule.trigger).toEqual({ on: 'contact.eta_below', contact: LISA, minutes: 3 });
  });

  it('rejects invalid choices with readable German errors', () => {
    const r = instantiateTemplate(template('core.almost-there'), { contact: 'nobody', minutes: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(['Person: kein gültiger Kontakt', 'Minuten: 0 bis 120 Minuten']);
  });

  it('only allows "anyone" where the template says so', () => {
    expect(instantiateTemplate(template('core.arrival-alert'), { contact: 'any' }).ok).toBe(true);
    expect(instantiateTemplate(template('core.home-safe'), { contact: 'any', myplace: 'home' }).ok).toBe(false);
  });
});

describe('AutomationEngine', () => {
  it('runs the shopping example from the plan', () => {
    const rule = fromTemplate('core.shopping-help', { contact: LISA, place: 'Supermarkt' });
    const engine = engineWith([rule]);
    const out = engine.handle({ type: 'contact.leave', contact: LISA, placeName: 'supermarkt', at: 0 });
    expect(out).toEqual([
      {
        kind: 'notify',
        ruleId: rule.id,
        title: 'Einkauf ist unterwegs 🛍️',
        body: 'Lisa hat supermarkt verlassen. Gleich beim Tragen helfen?',
      },
    ]);
    expect(engine.handle({ type: 'contact.leave', contact: MAX, placeName: 'Supermarkt', at: 0 })).toEqual([]);
  });

  it('fires "almost there" once per trip, not on every update', () => {
    const rule = fromTemplate('core.almost-there', { contact: 'any', minutes: 5 });
    const engine = engineWith([rule]);
    const eta = (m: number, at: number, sessionId = 'trip-0001'): AutomationEvent => ({
      type: 'contact.eta',
      contact: LISA,
      sessionId,
      etaMinutes: m,
      destinationName: 'Zuhause',
      at,
    });
    expect(engine.handle(eta(15, 0))).toEqual([]);
    const fired = engine.handle(eta(4, 120_000));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ body: 'Lisa kommt in ca. 4 min an.' });
    expect(engine.handle(eta(0, 300_000))).toEqual([]);
    // A new trip may fire again.
    expect(engine.handle(eta(3, 900_000, 'trip-0002'))).toHaveLength(1);
  });

  it('respects conditions', () => {
    const rule: Rule = {
      ...fromTemplate('core.arrival-alert', { contact: LISA, place: 'Zuhause' }),
      conditions: [{ if: 'time_between', from: '22:00', to: '06:00' }, { if: 'me.not_at', place: 'home' }],
    };
    const ev: AutomationEvent = { type: 'contact.arrive', contact: LISA, placeName: 'Zuhause', at: 0 };
    expect(engineWith([rule], { minutes: 23 * 60 }).handle(ev)).toHaveLength(1);
    expect(engineWith([rule], { minutes: 3 * 60 }).handle(ev)).toHaveLength(1);
    expect(engineWith([rule], { minutes: 12 * 60 }).handle(ev)).toHaveLength(0);
    expect(engineWith([rule], { minutes: 23 * 60, atPlace: ['home'] }).handle(ev)).toHaveLength(0);
  });

  it('rate-limits rules and messages so nobody can build a spam loop', () => {
    const rule = fromTemplate('core.home-safe', { myplace: 'home', contact: MAX });
    const engine = engineWith([rule]);
    const arrive = (at: number): AutomationEvent => ({ type: 'me.arrive', placeId: 'home', at });
    expect(engine.handle(arrive(0))).toHaveLength(1);
    expect(engine.handle(arrive(30_000))).toHaveLength(0); // cooldown
    let sent = 1;
    for (let t = 61_000; t < 3_600_000; t += 61_000) sent += engine.handle(arrive(t)).length;
    expect(sent).toBe(10); // per-contact message cap per hour
  });

  it('lets rules act again one cooldown after the clock jumps back, instead of waiting for it to catch up', () => {
    const rule = fromTemplate('core.home-safe', { myplace: 'home', contact: MAX });
    const engine = engineWith([rule]);
    const arrive = (at: number): AutomationEvent => ({ type: 'me.arrive', placeId: 'home', at });
    const T = 10 * 3_600_000;
    expect(engine.handle(arrive(T))).toHaveLength(1);
    const back = T - 2 * 3_600_000; // the clock is set back by two hours
    expect(engine.handle(arrive(back))).toHaveLength(0); // the firing just before still counts
    expect(engine.handle(arrive(back + 30_000))).toHaveLength(0); // the cooldown counts from the jump
    expect(engine.handle(arrive(back + 61_000))).toHaveLength(1);
  });

  it('holds the hourly caps for at most an hour after the clock jumps back', () => {
    const rule = fromTemplate('core.home-safe', { myplace: 'home', contact: MAX });
    const engine = engineWith([rule]);
    const arrive = (at: number): AutomationEvent => ({ type: 'me.arrive', placeId: 'home', at });
    const T = 10 * 3_600_000;
    let sent = 0;
    for (let t = T; t < T + 3_600_000; t += 61_000) sent += engine.handle(arrive(t)).length;
    expect(sent).toBe(10);
    const back = T - 2 * 3_600_000;
    expect(engine.handle(arrive(back))).toHaveLength(0);
    expect(engine.handle(arrive(back + 30 * 60_000))).toHaveLength(0); // still within the hour
    expect(engine.handle(arrive(back + 3_600_000 + 1_000))).toHaveLength(1);
  });

  it('keeps the cooldown when an event carries an older time than the last firing (a late fix)', () => {
    const rule = fromTemplate('core.home-safe', { myplace: 'home', contact: MAX });
    const engine = engineWith([rule]);
    const arrive = (at: number): AutomationEvent => ({ type: 'me.arrive', placeId: 'home', at });
    const T = 10 * 3_600_000;
    expect(engine.handle(arrive(T))).toHaveLength(1); // the OS region event, with my clock
    expect(engine.handle(arrive(T - 90_000))).toHaveLength(0); // from a fix that came late
    expect(engine.handle(arrive(T + 10_000))).toHaveLength(0); // my clock again
    expect(engine.handle(arrive(T + 61_000))).toHaveLength(1);
  });

  it('measures the cooldown by the clock it is given, whatever time the events carry', () => {
    const rule = fromTemplate('core.home-safe', { myplace: 'home', contact: MAX });
    const engine = engineWith([rule]);
    const arrive = (at: number): AutomationEvent => ({ type: 'me.arrive', placeId: 'home', at });
    const T = 10 * 3_600_000;
    expect(engine.handle(arrive(T), T)).toHaveLength(1);
    // A late batch of fixes: leaving and arriving again, with times from minutes ago.
    expect(engine.handle({ type: 'me.leave', placeId: 'home', at: T - 200_000 }, T + 1_000)).toHaveLength(0);
    expect(engine.handle(arrive(T - 80_000), T + 2_000)).toHaveLength(0);
    expect(engine.handle(arrive(T - 10_000), T + 61_000)).toHaveLength(1);
  });

  it('keeps the cooldown through a few seconds of jitter between event clocks', () => {
    const rule = fromTemplate('core.home-safe', { myplace: 'home', contact: MAX });
    const engine = engineWith([rule]);
    const arrive = (at: number): AutomationEvent => ({ type: 'me.arrive', placeId: 'home', at });
    const T = 10 * 3_600_000;
    expect(engine.handle(arrive(T))).toHaveLength(1);
    expect(engine.handle(arrive(T - 5_000))).toHaveLength(0);
    expect(engine.handle(arrive(T + 30_000))).toHaveLength(0);
  });

  it('ignores disabled rules', () => {
    const rule = { ...fromTemplate('core.trip-start', { contact: LISA }), enabled: false };
    expect(
      engineWith([rule]).handle({ type: 'contact.trip_start', contact: LISA, sessionId: 'abcdefgh', destinationName: 'X', at: 0 }),
    ).toEqual([]);
  });
});

describe('render', () => {
  it('fills only known variables and never evaluates anything', () => {
    expect(render('{{contact}} {{constructor}} {{__proto__}} ${1+1}', { contact: 'Lisa' }, 100)).toBe(
      'Lisa  {{__proto__}} ${1+1}',
    );
  });

  it('cuts to the limit without splitting emoji', () => {
    expect(render('🛍️🛍️🛍️', {}, 2)).toBe('🛍️');
  });
});

describe('validateRule', () => {
  it('rejects automations that try to start precise sharing', () => {
    const rule = fromTemplate('core.share-on-leave', { from: 'work', to: 'home', contact: MAX });
    const tampered = { ...rule, actions: [{ ...rule.actions[0], level: 'precise' }] };
    expect(validateRule(tampered).ok).toBe(false);
  });

  it('rejects unknown fields', () => {
    const rule = fromTemplate('core.trip-start', { contact: LISA });
    expect(validateRule({ ...rule, script: 'fetch("evil")' }).ok).toBe(false);
  });
});

describe('describeRule', () => {
  it('writes a readable German sentence', () => {
    const n = { contactName: (k: string) => names[k] ?? '?', placeName: (id: string) => (id === 'home' ? 'Zuhause' : id) };
    expect(describeRule(fromTemplate('core.shopping-help', { contact: LISA, place: 'Rewe' }), n)).toBe(
      'Wenn Lisa „Rewe“ verlässt: Zeige „Einkauf ist unterwegs 🛍️“ an.',
    );
    expect(describeRule(fromTemplate('core.share-on-leave', { from: 'work', to: 'home', contact: MAX }), n)).toBe(
      'Wenn ich „work“ verlasse: Teile deine Ankunftszeit nach „Zuhause“ mit Max.',
    );
  });

  it('shows message variables the way they will read', () => {
    const n = { contactName: (k: string) => names[k] ?? '?', placeName: (id: string) => (id === 'home' ? 'Zuhause' : id) };
    expect(describeRule(fromTemplate('core.almost-there', { contact: LISA, minutes: 5 }), n)).toBe(
      'Wenn Lisa weniger als 5 Minuten entfernt ist: Zeige „Lisa ist gleich da“ an.',
    );
    expect(describeRule(fromTemplate('core.arrival-alert', { contact: 'any', place: 'Schule' }), n)).toBe(
      'Wenn jemand bei „Schule“ ankommt: Zeige „[Person] ist da“ an.',
    );
    expect(describeRule(fromTemplate('core.home-safe', { myplace: 'home', contact: MAX }), n)).toBe(
      'Wenn ich bei „Zuhause“ ankomme: Melde Max „Bin gut bei Zuhause angekommen ✅“.',
    );
  });
});

describe('importPlugin', () => {
  const plugin = {
    format: 'heyda.plugin',
    version: 1,
    id: 'exeler.einkauf',
    name: 'Einkaufs-Helfer',
    description: 'Hilft beim Einkaufen.',
    author: 'Exeler',
    templates: [
      {
        id: 'exeler.einkauf.kasse',
        title: 'An der Kasse',
        sentence: 'Wenn {contact} {place} verlässt, sag Bescheid',
        category: 'alltag',
        slots: [
          { name: 'contact', kind: 'contact', label: 'Person' },
          { name: 'place', kind: 'place_name', label: 'Laden' },
        ],
        rule: {
          name: 'Kasse',
          trigger: { on: 'contact.leave', contact: '{{slot:contact}}', place: '{{slot:place}}' },
          conditions: [],
          actions: [{ do: 'notify', title: '{{contact}} ist fertig', body: 'Kommt gleich heim.' }],
        },
      },
    ],
  };

  it('imports a valid plugin and lists what it may do', () => {
    const r = importPlugin(JSON.stringify(plugin));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.capabilities.sort()).toEqual(['notify', 'react_to_contacts']);
  });

  it('refuses plugins that hard-code a contact', () => {
    const evil = structuredClone(plugin);
    evil.templates[0]!.rule.trigger.contact = LISA;
    const r = importPlugin(JSON.stringify(evil));
    expect(r.ok).toBe(false);
  });

  it('refuses gaps that are not declared', () => {
    const bad = structuredClone(plugin);
    bad.templates[0]!.rule.actions[0]!.body = '{{slot:secret}}';
    expect(importPlugin(JSON.stringify(bad)).ok).toBe(false);
  });

  it('refuses executable-looking extras', () => {
    const bad = { ...plugin, code: 'alert(1)' };
    expect(importPlugin(JSON.stringify(bad)).ok).toBe(false);
  });
});
