import { describe, expect, it } from 'vitest';
import { CrashReloadPolicy, wantsSystemNotification } from './window-policy';

describe('wantsSystemNotification', () => {
  const onScreen = { visible: true, focused: true, minimized: false };

  it('leaves alerts to the in-app banner while the window is on screen and focused', () => {
    expect(wantsSystemNotification('normal', onScreen)).toBe(false);
    expect(wantsSystemNotification('silent', onScreen)).toBe(false);
  });

  it('shows a system notification when the window is hidden, in the background or minimized', () => {
    for (const level of ['normal', 'silent'] as const) {
      expect(wantsSystemNotification(level, { ...onScreen, visible: false, focused: false })).toBe(true);
      expect(wantsSystemNotification(level, { ...onScreen, focused: false })).toBe(true);
      expect(wantsSystemNotification(level, { ...onScreen, minimized: true })).toBe(true);
      expect(wantsSystemNotification(level, null)).toBe(true);
    }
  });

  it('always shows alarms', () => {
    expect(wantsSystemNotification('alarm', onScreen)).toBe(true);
    expect(wantsSystemNotification('alarm', null)).toBe(true);
  });
});

describe('CrashReloadPolicy', () => {
  it('reloads a few times, then stops within the window', () => {
    const policy = new CrashReloadPolicy(3, 60_000);
    expect(policy.shouldReload(0)).toBe(true);
    expect(policy.shouldReload(1_000)).toBe(true);
    expect(policy.shouldReload(2_000)).toBe(true);
    expect(policy.shouldReload(3_000)).toBe(false);
    expect(policy.shouldReload(4_000)).toBe(false);
  });

  it('forgets old crashes', () => {
    const policy = new CrashReloadPolicy(2, 60_000);
    expect(policy.shouldReload(0)).toBe(true);
    expect(policy.shouldReload(10_000)).toBe(true);
    expect(policy.shouldReload(20_000)).toBe(false);
    // The first two crashes are older than the window by now; the refused one at 20 s still counts.
    expect(policy.shouldReload(75_000)).toBe(true);
    expect(policy.shouldReload(76_000)).toBe(false);
  });

  it('starts over after a reset', () => {
    const policy = new CrashReloadPolicy(1, 60_000);
    expect(policy.shouldReload(0)).toBe(true);
    expect(policy.shouldReload(1)).toBe(false);
    policy.reset();
    expect(policy.shouldReload(2)).toBe(true);
  });
});
