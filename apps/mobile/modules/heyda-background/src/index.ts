/**
 * Types and constants of the local Expo module "HeydaBackground" (Android only).
 * The app talks to it through src/lib/keepalive.ts, which loads it with
 * requireOptionalNativeModule so iOS, web and Expo Go get no-op fallbacks.
 */

/** Name the Kotlin module registers (Name("HeydaBackground")). */
export const HEYDA_BACKGROUND_MODULE = 'HeydaBackground';

/** Headless JS task run by the foreground service (KeepAliveService.TASK_KEY). */
export const KEEP_ALIVE_TASK = 'HeydaKeepAlive';

/** Notification text used when start() gets empty strings (same defaults as the Kotlin side). */
export const KEEP_ALIVE_DEFAULT_TEXT = {
  title: 'Heyda. ist verbunden',
  body: 'Damit Nachrichten und Notrufe sofort ankommen.',
} as const;

/** `code` of the errors start() and openBatteryOptimizationSettings() reject with. */
export type HeydaBackgroundErrorCode =
  /** Android 12+ refused a foreground-service start because the app was in the background. */
  | 'ERR_KEEPALIVE_NOT_ALLOWED'
  /** Any other refusal (see the message). */
  | 'ERR_KEEPALIVE_START_FAILED'
  /** Neither the battery optimization list nor the app info screen could be opened. */
  | 'ERR_KEEPALIVE_SETTINGS_UNAVAILABLE';

export interface HeydaBackgroundNativeModule {
  /**
   * Starts the foreground service with its headless JS task, or only updates the notification
   * text when it already runs. Resolves once Android accepted the start request; the service
   * itself starts a moment later. Text is trimmed and cut to 200 characters; empty -> default.
   */
  start(title: string | null, body: string | null): Promise<void>;
  /** Stops the service. Safe to call when it is not running. */
  stop(): Promise<void>;
  /** True while the service is in the foreground. */
  isRunning(): Promise<boolean>;
  /** Persisted flag: restart the service after a reboot or an app update. */
  setStartOnBoot(enabled: boolean): Promise<void>;
  /** PowerManager.isIgnoringBatteryOptimizations for this app. */
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  /** NotificationManager.isNotificationPolicyAccessGranted: may the app's alarm channel bypass Do Not Disturb? */
  isNotificationPolicyAccessGranted(): Promise<boolean>;
  /** Opens Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS (falls back to the app info page). */
  openBatteryOptimizationSettings(): Promise<void>;
}
