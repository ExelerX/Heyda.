// Pure decisions about notifications and the UI process for the main process. No Electron imports, so unit-tested.
import type { NotificationLevel } from './contract';

export interface WindowState {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
}

/**
 * The UI shows its own banner for every alert while it is on screen (lib/notifications.ts relies on the
 * shell for this), so a system notification would only repeat it. Alarms always get one: the in-app
 * alarm screen has no sound on the desktop, and a focused window does not mean anyone is looking at it.
 */
export function wantsSystemNotification(level: NotificationLevel, window: WindowState | null): boolean {
  if (level === 'alarm') return true;
  return !(window !== null && window.visible && window.focused && !window.minimized);
}

/**
 * The relay connection, the alarm timers and the vault writes all live in the UI process. If it dies
 * while the window is hidden in the tray, nothing would arrive any more and nobody would notice, so the
 * UI is reloaded. A UI that keeps dying is left alone after a few attempts (no endless crash loop).
 */
export class CrashReloadPolicy {
  private readonly crashes: number[] = [];

  constructor(
    private readonly maxReloads = 3,
    private readonly windowMs = 10 * 60_000,
  ) {}

  /** Records a crash at `now` and says whether the UI should be reloaded. */
  shouldReload(now: number): boolean {
    while (this.crashes.length > 0 && now - this.crashes[0]! >= this.windowMs) this.crashes.shift();
    this.crashes.push(now);
    return this.crashes.length <= this.maxReloads;
  }

  /** After the user asked for the UI again: start counting from zero. */
  reset(): void {
    this.crashes.length = 0;
  }
}
