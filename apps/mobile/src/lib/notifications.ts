import type { ContactKey } from '@heyda/core';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

/**
 * Local notifications only: they are created on this phone from messages it received.
 * No push token is requested and nothing is registered with Apple, Google or Expo.
 */
const CHANNEL = 'friends';
const native = Platform.OS === 'ios' || Platform.OS === 'android';

export interface Toast {
  id: number;
  title: string;
  body: string;
}

const toastListeners = new Set<(t: Toast) => void>();
let toastId = 0;
/** The chat currently on screen; its messages need no banner. */
let openChat: ContactKey | undefined;
let setup: Promise<boolean> | undefined;

if (native) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export function onToast(listener: (t: Toast) => void): () => void {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}

export function setOpenChat(key: ContactKey | undefined): void {
  openChat = key;
}

/** Asks for permission once. Only call from the UI. */
export function setupNotifications(): Promise<boolean> {
  setup ??= (async () => {
    if (!native) return false;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Freunde',
        importance: Notifications.AndroidImportance.HIGH,
        // Hide names and places on a locked screen.
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      });
    }
    if ((await Notifications.getPermissionsAsync()).granted) return true;
    const asked = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return asked.granted;
  })().catch(() => {
    setup = undefined;
    return false;
  });
  return setup;
}

/** In the app: a small banner. In the background: a system notification. */
export function deliver(title: string, body: string, from?: ContactKey): void {
  const active = AppState.currentState === 'active' || !native;
  if (active) {
    if (from && from === openChat) return;
    const toast = { id: ++toastId, title, body };
    toastListeners.forEach((l) => l(toast));
    return;
  }
  void (async () => {
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  })().catch(() => {});
}
