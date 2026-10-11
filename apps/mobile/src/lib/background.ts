import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { registerKeepAliveTask } from './keepalive';
import { applyLocationNeeds, freshFix, locationSupported, registerGeofences } from './location';
import { getRuntime, onRuntimeCreated } from './runtime';

/**
 * Connects every runtime (UI or a background launch without UI) to the platform:
 * location tracking as the core asks for it, places to the OS geofencer, and the
 * background tasks that keep messages, SOS alerts and watch alarms coming in.
 * Demo mode never touches real location.
 */
onRuntimeCreated((runtime) => {
  if (runtime.isDemo || !locationSupported) return;
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
 * ~15 minutes, at its own discretion). Each time, fetch what arrived, update alarms, save.
 */
export const SYNC_TASK = 'heyda-sync';
const LISTEN_MS = 20_000;

if (Platform.OS === 'ios' || Platform.OS === 'android') {
  TaskManager.defineTask(SYNC_TASK, async () => {
    try {
      const runtime = await getRuntime();
      await new Promise((r) => setTimeout(r, LISTEN_MS));
      await runtime.tick();
      await runtime.flush();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerBackgroundSync(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
  if (await TaskManager.isTaskRegisteredAsync(SYNC_TASK)) return;
  await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: 15 });
}
