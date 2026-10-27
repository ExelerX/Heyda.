import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { registerKeepAliveTask, setKeepAliveOnBoot, stopKeepAlive } from './keepalive';
import { applyLocationNeeds, freshFix, locationSupported, registerGeofences, stopLocation } from './location';
import { getRuntime, onRuntimeCreated, type AppRuntime } from './runtime';

/**
 * Connects every runtime (UI or a background launch without UI) to the platform:
 * location tracking as the core asks for it, places to the OS geofencer, and the
 * background tasks that keep messages, SOS alerts and watch alarms coming in.
 * Demo mode never touches real location.
 */
onRuntimeCreated((runtime) => {
  if (runtime.isDemo) {
    // Taking over from a real account: its GPS tracking, places watched by the OS, background
    // wakes and keep-alive must not keep running for the demo. They come back when the demo ends.
    if (locationSupported) {
      void stopLocation().catch(() => {});
      void registerGeofences([]).catch(() => {});
    }
    void unregisterBackgroundSync().catch(() => {});
    void stopKeepAlive().catch(() => {});
    void setKeepAliveOnBoot(false).catch(() => {});
    return;
  }
  if (!locationSupported) return;
  runtime.hooks = {
    onLocationNeeds: (needs) => void applyLocationNeeds(needs).catch(() => {}),
    onPlacesChange: (places) => void registerGeofences(places).catch(() => {}),
    freshFix: () => freshFix(),
  };
});

/** Android: the keep-alive service runs this while the app is in the background. */
registerKeepAliveTask(async () => {
  await getRuntime();
});

/**
 * iOS (and Android without keep-alive): the OS wakes the app now and then (at most every
 * ~15 minutes, at its own discretion). Each time, fetch what arrived, send what waited, update
 * alarms, save.
 */
export const SYNC_TASK = 'heyda-sync';
/** Listens at least this long for what arrives. */
const LISTEN_MS = 20_000;
/** The OS may end a background task after about 30 s: everything, saving included, fits in this. */
const BUDGET_MS = 25_000;
/** Kept free at the end for saving. */
const SAVE_MS = 4_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
/** Waits for `work`, but not past `deadline` (epoch ms). */
const until = (deadline: number, work: Promise<unknown>) => Promise.race([work.then(() => {}, () => {}), sleep(deadline - Date.now())]);

if (Platform.OS === 'ios' || Platform.OS === 'android') {
  TaskManager.defineTask(SYNC_TASK, async () => {
    const saveBy = Date.now() + BUDGET_MS - SAVE_MS;
    let runtime: AppRuntime | undefined;
    let expiry: { remove: () => void } | undefined;
    try {
      // iOS: the OS ends it early. Save what came in so far (a message sent is then not sent again).
      expiry = BackgroundTask.addExpirationListener(() => void runtime?.flush().catch(() => {}));
    } catch {
      // Android has no such notice; the budget below keeps it in time.
    }
    try {
      runtime = await getRuntime();
      // The first round sends what waited in the outbox meanwhile; a slow network can make it take
      // longer than the listening, and its sending must be over before the next round and the save.
      await until(saveBy, Promise.all([sleep(LISTEN_MS), runtime.whenFirstRoundDone()]));
      await until(saveBy, runtime.tick());
      await runtime.flush();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    } finally {
      expiry?.remove();
    }
  });
}

/** No more background wakes, e.g. while the demo runs. */
export async function unregisterBackgroundSync(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  if (await TaskManager.isTaskRegisteredAsync(SYNC_TASK)) await BackgroundTask.unregisterTaskAsync(SYNC_TASK);
}

export async function registerBackgroundSync(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
  if (await TaskManager.isTaskRegisteredAsync(SYNC_TASK)) return;
  await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: 15 });
}
