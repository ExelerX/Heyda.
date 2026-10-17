import { describe, expect, it } from 'vitest';
import { alertLevel, DEFAULT_PREFS, dndEndsAt, isDndActive, normalizePrefs, scheduleActive, type AlertCategory } from './prefs';

const at = (weekday: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return { weekday, minutes: h! * 60 + m! };
};

describe('quiet mode', () => {
  const night = { enabled: true, from: '22:00', to: '07:00', days: [5] }; // starts Friday evening

  it('wraps past midnight and belongs to the day it started', () => {
    expect(scheduleActive(night, at(5, '23:30'))).toBe(true);
    expect(scheduleActive(night, at(6, '06:59'))).toBe(true); // Saturday morning, started Friday
    expect(scheduleActive(night, at(6, '07:00'))).toBe(false);
    expect(scheduleActive(night, at(5, '06:00'))).toBe(false); // Friday morning belongs to Thursday
    expect(scheduleActive({ ...night, days: [7] }, at(1, '03:00'))).toBe(true); // Sunday night into Monday
  });

  it('is off when disabled or from equals to', () => {
    expect(scheduleActive({ ...night, enabled: false }, at(5, '23:00'))).toBe(false);
    expect(scheduleActive({ ...night, to: '22:00' }, at(5, '23:00'))).toBe(false);
  });

  it('manual quiet mode wins and ends on time', () => {
    const dnd = { ...DEFAULT_PREFS.dnd, manual: { until: 1000 } };
    const lt = () => at(3, '12:00');
    expect(isDndActive(dnd, 999, lt)).toBe(true);
    expect(isDndActive(dnd, 1000, lt)).toBe(false);
    expect(dndEndsAt(dnd, 500, lt)).toBe(1000);
    expect(dndEndsAt({ ...dnd, manual: {} }, 500, lt)).toBeUndefined();
  });
});

describe('alertLevel', () => {
  const prefs = DEFAULT_PREFS;

  it('always rings for SOS, even muted and in quiet mode', () => {
    expect(alertLevel({ category: 'sos', muted: true }, prefs, true)).toBe('alarm');
  });

  it('rings for overdue watches unless the user turned that off for quiet mode', () => {
    expect(alertLevel({ category: 'watch' }, prefs, true)).toBe('alarm');
    expect(alertLevel({ category: 'watch' }, { ...prefs, dnd: { ...prefs.dnd, allowWatch: false } }, true)).toBe('silent');
  });

  it('past the hourly budget, SOS and watch alarms are a normal notification nothing can switch off', () => {
    const everythingOff = { ...prefs, off: ['chat', 'trip', 'checkin'] as AlertCategory[] };
    expect(alertLevel({ category: 'sos', muted: true, overBudget: true }, everythingOff, true)).toBe('normal');
    expect(alertLevel({ category: 'watch', muted: true, overBudget: true }, everythingOff, true)).toBe('normal');
    expect(alertLevel({ category: 'watch', overBudget: true }, prefs, false)).toBe('normal');
    // Only "Pass auf mich auf durchlassen" switched off keeps them quiet in quiet mode, as for any watch.
    expect(alertLevel({ category: 'watch', overBudget: true }, { ...prefs, dnd: { ...prefs.dnd, allowWatch: false } }, true)).toBe('silent');
  });

  it('handles categories, mutes, favourites and urgent messages', () => {
    expect(alertLevel({ category: 'status' }, prefs, false)).toBe('feed'); // off by default
    expect(alertLevel({ category: 'chat', muted: true }, prefs, false)).toBe('feed');
    expect(alertLevel({ category: 'chat' }, prefs, false)).toBe('normal');
    expect(alertLevel({ category: 'chat' }, prefs, true)).toBe('silent');
    expect(alertLevel({ category: 'chat', favorite: true }, prefs, true)).toBe('normal');
    expect(alertLevel({ category: 'chat', urgent: true }, prefs, true)).toBe('silent');
    expect(alertLevel({ category: 'chat', urgent: true }, { ...prefs, dnd: { ...prefs.dnd, urgentFrom: 'all' } }, true)).toBe('normal');
  });
});

describe('normalizePrefs', () => {
  it('repairs broken saved data and never lets SOS be switched off', () => {
    const p = normalizePrefs({
      dnd: { schedule: { enabled: true, from: '25:00', to: 'x', days: [0, 3, 3, 9] } } as never,
      off: ['sos', 'chat', 'bogus'] as never,
    });
    expect(p.dnd.schedule).toEqual({ enabled: true, from: '22:00', to: '07:00', days: [3] });
    expect(p.off).toEqual(['chat']);
    expect(p.dnd.urgentFrom).toBe('favorites');
  });
});
