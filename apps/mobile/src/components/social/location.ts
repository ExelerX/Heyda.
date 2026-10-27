import * as Location from 'expo-location';
import { freshFix, locationSupported, requestLocationAccess, type LocationAccess } from '../../lib/location';
import { isDesktop } from '../../lib/platform';
import type { AppRuntime } from '../../lib/runtime';

/**
 * A made-up position for demo mode, about 1.5 km from the demo home: demo mode never reads
 * the real location, but answers, trips and live shares still have something to work with.
 */
const DEMO_POSITION = { lat: 52.529, lon: 13.4285, accuracyM: 25 };

/** True when this device can know where it is (a phone, or the demo). */
export function canLocate(isDemo: boolean): boolean {
  return isDemo || locationSupported;
}

/** Plain words for why location features need the phone. */
export const NO_GPS_TEXT = isDesktop
  ? 'Am Computer gibt es kein GPS. Dafür brauchst du die App auf deinem Handy.'
  : 'Dieses Gerät kennt seinen Standort nicht. Dafür brauchst du die App auf deinem Handy.';

function timeout(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Gets a recent location fix into the node, so the next answer, trip or live share has one.
 * Demo: the made-up position. Phone: one GPS fix (never waits longer than a few seconds).
 * Returns whether the node now has a fresh fix.
 */
export async function ensureFix(runtime: AppRuntime, maxAgeMs = 2 * 60_000): Promise<boolean> {
  if (runtime.node.freshFix(maxAgeMs)) return true;
  if (runtime.isDemo) {
    await runtime.node.onLocationFix({ ...DEMO_POSITION, timestamp: Date.now() });
  } else if (locationSupported) {
    await Promise.race([freshFix().catch(() => {}), timeout(8000)]);
  }
  return !!runtime.node.freshFix(maxAgeMs);
}

/** For one-off answers ("Wo bist du?"): only foreground access, never background. */
export async function ensureForegroundAccess(isDemo: boolean): Promise<boolean> {
  if (isDemo) return true;
  if (!locationSupported) return false;
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) return true;
  const asked = await Location.requestForegroundPermissionsAsync();
  return asked.granted;
}

/** For trips and live shares, which keep running in the background. */
export async function ensureTrackingAccess(isDemo: boolean): Promise<LocationAccess> {
  if (isDemo) return 'always';
  return requestLocationAccess();
}

/** My exact position, only for "Mich zeigen" on the map. Never sent anywhere. */
export async function myPosition(): Promise<{ lat: number; lon: number; accuracyM?: number } | undefined> {
  if (!locationSupported) return undefined;
  if (!(await ensureForegroundAccess(false))) return undefined;
  const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { lat: l.coords.latitude, lon: l.coords.longitude, accuracyM: l.coords.accuracy ?? undefined };
}
