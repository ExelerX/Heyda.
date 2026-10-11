import type { LocationFix, Place } from '@heyda/core';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { getRuntime } from './runtime';

/**
 * Bridges the OS location services to the SocialNode. The exact position only ever
 * goes into `node.onLocationFix`; what leaves the phone is decided by the core's
 * privacy gate, never here.
 */
export const GEOFENCE_TASK = 'heyda-geofence';
export const TRIP_TASK = 'heyda-trip';

/** iOS monitors at most 20 regions per app. */
export const MAX_REGIONS = 20;
/** Below ~100 m OS geofences get unreliable, because they use Wi-Fi and cell positioning. */
const MIN_REGION_RADIUS_M = 100;
/** Right after registering, the OS reports the current state as Enter/Exit. That is not news. */
const REGISTRATION_GRACE_MS = 20_000;

export const locationSupported = Platform.OS === 'ios' || Platform.OS === 'android';

export type LocationAccess = 'always' | 'while-using' | 'denied';

let registeredAt = 0;
let foregroundWatch: Location.LocationSubscription | undefined;

function toFix(l: Location.LocationObject): LocationFix {
  const { latitude, longitude, accuracy, speed } = l.coords;
  return {
    lat: latitude,
    lon: longitude,
    timestamp: l.timestamp,
    accuracyM: accuracy ?? undefined,
    speedMps: speed != null && speed >= 0 ? speed : undefined,
  };
}

async function feed(locations: Location.LocationObject[]): Promise<void> {
  const runtime = await getRuntime();
  for (const l of locations) await runtime.node.onLocationFix(toFix(l));
  await runtime.flushIfDirty();
}

interface GeofenceTaskData {
  eventType: Location.GeofencingEventType;
  region: Location.LocationRegion;
}

interface TripTaskData {
  locations: Location.LocationObject[];
}

// Tasks must be defined when the JS bundle loads, including headless background launches.
if (locationSupported) {
  TaskManager.defineTask<GeofenceTaskData>(GEOFENCE_TASK, async ({ data, error }) => {
    const placeId = data?.region?.identifier;
    if (error || !placeId) return;
    const runtime = await getRuntime();
    const inside = data.eventType === Location.GeofencingEventType.Enter;
    if (Date.now() - registeredAt < REGISTRATION_GRACE_MS) runtime.node.syncPlaceState(placeId, inside);
    else await runtime.node.onPlaceTransition(placeId, inside ? 'arrive' : 'leave');
    await runtime.flushIfDirty();
  });

  TaskManager.defineTask<TripTaskData>(TRIP_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    await feed(data.locations);
  });
}

/** Asks for location access. Only call from the UI, in response to something the user did. */
export async function requestLocationAccess(): Promise<LocationAccess> {
  if (!locationSupported) return 'denied';
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return 'denied';
  const bg = await Location.requestBackgroundPermissionsAsync();
  return bg.granted ? 'always' : 'while-using';
}

export async function currentLocationAccess(): Promise<LocationAccess> {
  if (!locationSupported) return 'denied';
  if ((await Location.getBackgroundPermissionsAsync()).granted) return 'always';
  return (await Location.getForegroundPermissionsAsync()).granted ? 'while-using' : 'denied';
}

/** One fix for "save this place here". */
export async function currentPosition(): Promise<{ lat: number; lon: number; accuracyM?: number }> {
  const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { lat: l.coords.latitude, lon: l.coords.longitude, accuracyM: l.coords.accuracy ?? undefined };
}

/**
 * Follows the phone while a trip is shared. With "always" access this keeps running in
 * the background, with a visible notification (Android) or the blue pill (iOS);
 * otherwise only while the app is open.
 */
export async function startTripTracking(): Promise<LocationAccess> {
  const access = await currentLocationAccess();
  if (access === 'always') {
    if (!(await Location.hasStartedLocationUpdatesAsync(TRIP_TASK))) {
      await Location.startLocationUpdatesAsync(TRIP_TASK, {
        accuracy: Location.Accuracy.High,
        distanceInterval: 50,
        timeInterval: 20_000,
        showsBackgroundLocationIndicator: true,
        pausesUpdatesAutomatically: false,
        activityType: Location.ActivityType.OtherNavigation,
        foregroundService: {
          notificationTitle: 'Du teilst deine Ankunftszeit',
          notificationBody: 'Endet automatisch bei Ankunft. Öffne die App, um früher zu stoppen.',
          notificationColor: '#F5A524',
          killServiceOnDestroy: false,
        },
      });
    }
  } else if (access === 'while-using' && !foregroundWatch) {
    foregroundWatch = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 50, timeInterval: 20_000 },
      (l) => void feed([l]),
    );
  }
  return access;
}

export async function stopTripTracking(): Promise<void> {
  foregroundWatch?.remove();
  foregroundWatch = undefined;
  if (locationSupported && (await Location.hasStartedLocationUpdatesAsync(TRIP_TASK))) {
    await Location.stopLocationUpdatesAsync(TRIP_TASK);
  }
}

/** Hands my places to the OS, which watches them even while the app is closed. */
export async function registerGeofences(places: Place[]): Promise<void> {
  if (!locationSupported) return;
  const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
  if (!places.length || (await currentLocationAccess()) !== 'always') {
    if (running) await Location.stopGeofencingAsync(GEOFENCE_TASK);
    return;
  }
  registeredAt = Date.now();
  await Location.startGeofencingAsync(
    GEOFENCE_TASK,
    places.slice(0, MAX_REGIONS).map((p) => ({
      identifier: p.id,
      latitude: p.center.lat,
      longitude: p.center.lon,
      radius: Math.max(p.radiusM, MIN_REGION_RADIUS_M),
      notifyOnEnter: true,
      notifyOnExit: true,
    })),
  );
}
