import * as Linking from 'expo-linking';
import * as SMS from 'expo-sms';
import { Platform } from 'react-native';
import { desktop, isNative } from './platform';
import type { AppRuntime } from './runtime';

/** Opens the phone app with the emergency number. 112 works in all of the EU, also without a SIM card. */
export async function callEmergency(number = '112'): Promise<void> {
  const url = `tel:${number}`;
  if (desktop) await desktop.openExternal(url);
  else await Linking.openURL(url);
}

export async function callPhone(phone: string): Promise<void> {
  const clean = phone.replace(/[^\d+]/g, '');
  if (!clean) return;
  if (desktop) await desktop.openExternal(`tel:${clean}`);
  else await Linking.openURL(`tel:${clean}`);
}

export async function smsAvailable(): Promise<boolean> {
  if (!isNative) return false;
  return SMS.isAvailableAsync().catch(() => false);
}

/**
 * Opens a prepared SMS to the emergency contacts with my location, for when the internet
 * is gone or someone does not have the app open. The user still has to press send.
 */
export async function sendSosSms(runtime: AppRuntime): Promise<'sent' | 'unavailable' | 'no-numbers' | 'cancelled'> {
  const fb = runtime.node.sosFallback();
  if (!fb || !fb.phones.length) return 'no-numbers';
  if (!(await smsAvailable())) return 'unavailable';
  const { result } = await SMS.sendSMSAsync(fb.phones, fb.text);
  return result === 'cancelled' ? 'cancelled' : 'sent';
}

/** Opens a location in the system's map app. */
export async function openInMaps(lat: number, lon: number, label = 'Standort'): Promise<void> {
  const url = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}`;
  if (desktop) {
    await desktop.openExternal(url);
    return;
  }
  if (Platform.OS === 'ios') {
    // Apple Maps; iOS has no generic geo: links.
    await Linking.openURL(`https://maps.apple.com/?ll=${lat.toFixed(5)},${lon.toFixed(5)}&q=${encodeURIComponent(label)}`);
    return;
  }
  // Android: the user's own map app (any app that handles geo: links).
  const geo = `geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(label)})`;
  // (canOpenURL would need a <queries> entry on Android 11+, so just try it.)
  if (isNative) {
    try {
      await Linking.openURL(geo);
      return;
    } catch {
      // no map app: the browser below
    }
  }
  await Linking.openURL(url);
}
