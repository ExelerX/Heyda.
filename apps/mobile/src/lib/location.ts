import type { LocationFix, LocationNeeds, Place } from '@heyda/core';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { getRuntime } from './runtime';

/**
 * Bridges the OS location services to the SocialNode. The exact position only ever
 * goes into `node.onLocationFixes`; what leaves the phone is decided by the core's
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
  // As one batch: if the fixes are dated ahead of the phone's clock, they keep their order and spacing.
  await runtime.node.onLocationFixes(locations.map(toFix));
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

let currentMode: LocationNeeds['mode'] = 'off';

const NOTIFICATION_TEXT: Record<string, { title: string; body: string }> = {
  sos: { title: '🆘 Notruf läuft', body: 'Dein Standort geht an deine Notfallkontakte.' },
  trip: { title: 'Du teilst deine Ankunftszeit', body: 'Endet automatisch bei Ankunft.' },
  live: { title: 'Du teilst deinen Standort live', body: 'Öffne Heyda., um es zu beenden.' },
};

/**
 * Runs the location tracking the core asks for: precise and frequent during a trip,
 * an SOS or a precise live share; rare and coarse for an area-only live share; otherwise none.
 * With "always" access it keeps running in the background with a visible notification
 * (Android) or the blue pill (iOS); otherwise only while the app is open.
 */
export async function applyLocationNeeds(needs: LocationNeeds): Promise<LocationAccess> {
  if (!locationSupported) return 'denied';
  const access = await currentLocationAccess();
  if (needs.mode === currentMode && (needs.mode === 'off' || foregroundWatch || (await isTracking()))) return access;
  await stopTracking();
  currentMode = needs.mode;
  if (needs.mode === 'off' || access === 'denied') return access;
  const high = needs.mode === 'high';
  const reason = needs.reasons.includes('sos') ? 'sos' : needs.reasons.includes('trip') ? 'trip' : 'live';
  const opts = high
    ? { accuracy: Location.Accuracy.High, distanceInterval: 25, timeInterval: 15_000 }
    : { accuracy: Location.Accuracy.Balanced, distanceInterval: 300, timeInterval: 5 * 60_000 };
  if (access === 'always') {
    await Location.startLocationUpdatesAsync(TRIP_TASK, {
      ...opts,
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.Other,
      foregroundService: {
        notificationTitle: NOTIFICATION_TEXT[reason]!.title,
        notificationBody: NOTIFICATION_TEXT[reason]!.body,
        notificationColor: reason === 'sos' ? '#E5484D' : '#F5A524',
        killServiceOnDestroy: false,
      },
    });
  } else {
    foregroundWatch = await Location.watchPositionAsync(opts, (l) => void feed([l]));
  }
  return access;
}

async function isTracking(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(TRIP_TASK).catch(() => false);
}

async function stopTracking(): Promise<void> {
  foregroundWatch?.remove();
  foregroundWatch = undefined;
  if (await isTracking()) await Location.stopLocationUpdatesAsync(TRIP_TASK).catch(() => {});
}

/** One fix right now, e.g. for an SOS or an answer to "where are you?". Feeds it to the node too. */
export async function freshFix(): Promise<void> {
  if (!locationSupported || (await currentLocationAccess()) === 'denied') return;
  const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  await feed([l]);
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
