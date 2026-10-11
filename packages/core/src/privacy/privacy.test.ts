import { describe, expect, it } from 'vitest';
import { distanceM } from '../geo/distance';
import { CoarseLocator, snapToGrid } from './coarse-grid';
import { bucketEtaMinutes } from './eta-rounding';
import { levelAllows } from './levels';
import { PrivacyPolicy, type PrivacyState } from './policy';
import { createSession } from '../session/session';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('bucketEtaMinutes', () => {
  it.each([
    [30, 0],
    [120, 0],
    [121, 3],
    [9 * 60 + 1, 10],
    [11 * 60, 15],
    [29 * 60, 30],
    [31 * 60, 40],
    [119 * 60, 120],
    [121 * 60, 150],
  ])('%is -> %i min', (seconds, minutes) => {
    expect(bucketEtaMinutes(seconds)).toBe(minutes);
  });

  it('treats garbage as arriving rather than throwing', () => {
    expect(bucketEtaMinutes(Number.NaN)).toBe(0);
  });
});

describe('snapToGrid', () => {
  const home = { lat: 52.52, lon: 13.405 };

  it('maps every point in a cell to the same centre', () => {
    const a = snapToGrid(home);
    const b = snapToGrid({ lat: home.lat + 0.0001, lon: home.lon + 0.0001 });
    expect(b.id).toBe(a.id);
    expect(b.lat).toBe(a.lat);
  });

  it('keeps the reported centre within one cell diagonal of the truth', () => {
    const c = snapToGrid(home, 2000);
    expect(distanceM(c, home)).toBeLessThan(Math.SQRT2 * 1000 + 1);
  });

  it('cannot be averaged towards the true position', () => {
    // Many reports from slightly different spots inside the cell all look identical.
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(snapToGrid({ lat: home.lat + i * 1e-6, lon: home.lon }).id);
    expect(ids.size).toBe(1);
  });

  it('rejects tiny cells', () => {
    expect(() => snapToGrid(home, 10)).toThrow(RangeError);
  });
});

describe('CoarseLocator', () => {
  it('does not flip back and forth along a border', () => {
    const cell = snapToGrid({ lat: 52.52, lon: 13.405 }, 2000);
    // A point just past the cell's east edge (half a cell plus 10 m).
    const mPerDegLon = 111_195 * Math.cos((cell.lat * Math.PI) / 180);
    const justOutside = { lat: cell.lat, lon: cell.lon + 1010 / mPerDegLon };
    const justInside = { lat: cell.lat, lon: cell.lon + 990 / mPerDegLon };

    const loc = new CoarseLocator(2000);
    expect(loc.update(cell)?.id).toBe(cell.id);
    for (let i = 0; i < 5; i++) {
      expect(loc.update(justOutside)).toBeUndefined();
      expect(loc.update(justInside)).toBeUndefined();
    }
    const farOutside = { lat: cell.lat, lon: cell.lon + 1500 / mPerDegLon };
    expect(loc.update(farOutside)?.id).not.toBe(cell.id);
  });
});

describe('levels', () => {
  it('orders event < eta < coarse < precise', () => {
    expect(levelAllows('coarse', 'eta')).toBe(true);
    expect(levelAllows('eta', 'coarse')).toBe(false);
    expect(levelAllows('precise', 'precise')).toBe(true);
  });
});

describe('PrivacyPolicy', () => {
  const now = 1_000_000;
  const state: PrivacyState = {
    ghost: false,
    grants: [
      { contactKey: A, placeIds: ['home', 'store'] },
      { contactKey: B, placeIds: ['store'], expiresAt: now + 1000 },
    ],
  };
  const policy = new PrivacyPolicy(() => state);

  it('sends place events only to contacts granted that place', () => {
    expect(policy.placeEventRecipients('home', now)).toEqual([A]);
    expect(policy.placeEventRecipients('store', now)).toEqual([A, B]);
    expect(policy.placeEventRecipients('work', now)).toEqual([]);
  });

  it('drops expired grants', () => {
    expect(policy.placeEventRecipients('store', now + 1000)).toEqual([A]);
  });

  it('sends nothing location-related in ghost mode', () => {
    const ghost = new PrivacyPolicy(() => ({ ...state, ghost: true }));
    expect(ghost.placeEventRecipients('home', now)).toEqual([]);
    const s = createSession({ recipients: [A], destinationName: 'Zuhause', now });
    expect(ghost.canSendSessionUpdate(A, s, { etaMinutes: 5 }, now)).toBe(false);
  });

  it('never sends more detail than the session level allows', () => {
    const s = createSession({ recipients: [A], destinationName: 'Zuhause', level: 'eta', now });
    expect(policy.canSendSessionUpdate(A, s, { etaMinutes: 5 }, now)).toBe(true);
    expect(policy.canSendSessionUpdate(A, s, { cell: {} }, now)).toBe(false);
    expect(policy.canSendSessionUpdate(A, s, { point: {} }, now)).toBe(false);
    expect(policy.canSendSessionUpdate(B, s, { etaMinutes: 5 }, now)).toBe(false);
  });

  it('stops after the session expires', () => {
    const s = createSession({ recipients: [A], destinationName: 'Zuhause', durationMs: 1000, now });
    expect(policy.canSendSessionUpdate(A, s, { etaMinutes: 5 }, now + 1000)).toBe(false);
  });
});

describe('createSession', () => {
  it('caps precise sharing at a day', () => {
    const s = createSession({ recipients: [A], destinationName: 'X', level: 'precise', durationMs: 30 * 3600_000, now: 0 });
    expect(s.expiresAt).toBe(24 * 3600_000);
  });

  it('needs a recipient', () => {
    expect(() => createSession({ recipients: [], destinationName: 'X' })).toThrow();
  });
});
