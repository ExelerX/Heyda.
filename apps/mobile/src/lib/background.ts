import { registerGeofences, startTripTracking, stopTripTracking } from './location';
import { deliver } from './notifications';
import { onRuntimeCreated } from './runtime';

/**
 * Connects every runtime (UI or headless background launch) to the platform:
 * notifications out, trip tracking on/off, places to the OS geofencer.
 * Demo mode never touches real location.
 */
onRuntimeCreated((runtime) => {
  runtime.notify = deliver;
  if (runtime.isDemo) return;
  runtime.onTripChange = (trip) => void (trip ? startTripTracking() : stopTripTracking()).catch(() => {});
  runtime.onPlacesChange = (places) => void registerGeofences(places).catch(() => {});
});
