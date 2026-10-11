import { requireOptionalNativeModule } from 'expo';
import { AppRegistry, Platform } from 'react-native';

import {
  HEYDA_BACKGROUND_MODULE,
  KEEP_ALIVE_DEFAULT_TEXT,
  KEEP_ALIVE_TASK,
  type HeydaBackgroundNativeModule,
} from '../../modules/heyda-background';

/**
 * Android keep-alive: a foreground service (type remoteMessaging, local module
 * modules/heyda-background) runs the headless JS task "HeydaKeepAlive", so the relay connection,
 * timers, SOS alerts and watch alarms keep working while the app is in the background.
 *
 * iOS, web and builds without the module (Expo Go) get no-ops: keepAliveSupported is false.
 * Errors from startKeepAlive carry a `code` (see HeydaBackgroundErrorCode), most importantly
 * 'ERR_KEEPALIVE_NOT_ALLOWED' when Android 12+ refuses a start from the background.
 */
const native: HeydaBackgroundNativeModule | null =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<HeydaBackgroundNativeModule>(HEYDA_BACKGROUND_MODULE)
    : null;

export const keepAliveSupported: boolean = native !== null;

let registered = false;
/** Resolvers of headless task runs that are still pending (normally zero or one). */
const pending = new Set<() => void>();

function releasePending(): void {
  const resolvers = [...pending];
  pending.clear();
  for (const resolve of resolvers) resolve();
}

/**
 * Registers the headless task. Call once at bundle load (before any UI), on every platform:
 * it does nothing outside Android. `run` should make sure the runtime and relay connection are up;
 * it is awaited each time the service starts the task, also after a reboot without UI.
 * The task then stays pending until stopKeepAlive() is called. If `run` rejects, the keep-alive
 * stops itself, so the notification never claims a connection that does not exist.
 */
export function registerKeepAliveTask(run: () => Promise<void>): void {
  if (Platform.OS !== 'android' || registered) return;
  if (typeof AppRegistry.registerHeadlessTask !== 'function') return;
  registered = true;
  AppRegistry.registerHeadlessTask(KEEP_ALIVE_TASK, () => async () => {
    // A new run supersedes one left over from a service instance the system has destroyed.
    releasePending();
    const stopped = new Promise<void>((resolve) => pending.add(resolve));
    try {
      await run();
    } catch (error) {
      console.warn('[keepalive] run() failed, stopping the keep-alive', error);
      await stopKeepAlive().catch(() => {});
    }
    await stopped;
  });
}

/**
 * Starts the foreground service (or updates its notification text when it already runs).
 * Call it while the app is visible: Android 12+ refuses starts from the background
 * (rejects with code 'ERR_KEEPALIVE_NOT_ALLOWED'). Resolves when Android accepted the request.
 */
export async function startKeepAlive(text: { title: string; body: string }): Promise<void> {
  if (!native) return;
  if (__DEV__ && !registered) {
    console.warn('[keepalive] registerKeepAliveTask() was not called; the service would stop at once.');
  }
  await native.start(text.title || KEEP_ALIVE_DEFAULT_TEXT.title, text.body || KEEP_ALIVE_DEFAULT_TEXT.body);
}

/** Ends the headless task and stops the service. Safe to call when it is not running. */
export async function stopKeepAlive(): Promise<void> {
  releasePending();
  if (!native) return;
  await native.stop();
}

export async function isKeepAliveRunning(): Promise<boolean> {
  if (!native) return false;
  return native.isRunning();
}

/** Restart the service after a reboot (and after an app update). Keep it in sync with the on/off setting. */
export async function setKeepAliveOnBoot(enabled: boolean): Promise<void> {
  if (!native) return;
  await native.setStartOnBoot(enabled);
}

/** True when the app is exempt from battery optimization. Also true where that concept does not exist (iOS, web). */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (!native) return true;
  return native.isIgnoringBatteryOptimizations();
}

/**
 * Android: true when the user allowed Heyda. to override Do Not Disturb. Without it, SOS and
 * watch alarms ring only when the phone itself is not in Do Not Disturb. Elsewhere: false.
 */
export async function isDndAccessGranted(): Promise<boolean> {
  if (!native) return false;
  return native.isNotificationPolicyAccessGranted().catch(() => false);
}

/** Opens the system screen where the user can set the app to "not optimized" / "unrestricted". */
export async function openBatteryOptimizationSettings(): Promise<void> {
  if (!native) return;
  await native.openBatteryOptimizationSettings();
}
