import type { Alarm, Alert, AlertLevel } from '@heyda/core';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { isDndAccessGranted } from './keepalive';
import { desktop, isNative } from './platform';

/**
 * Local notifications only: they are created on this device from messages it received.
 * No push token is requested and nothing is registered with Apple, Google or Expo.
 *
 * Three Android channels, so people can tune them in the system settings:
 * - "Notfall" (SOS, overdue check-ins): highest importance, may break through Do Not Disturb
 * - "Freunde": normal notifications with sound
 * - "Leise": shows up without sound (e.g. during quiet hours)
 */
export const CHANNELS = { alarm: 'heyda-alarm', alarmDnd: 'heyda-alarm-dnd', normal: 'heyda-friends', silent: 'heyda-quiet' } as const;

export interface Toast {
  id: string;
  title: string;
  body: string;
  level: AlertLevel;
  thread?: string;
  alert?: Alert;
}

const toastListeners = new Set<(t: Toast) => void>();
const openListeners = new Set<(alertId: string, data: Record<string, unknown>) => void>();
/** The chat currently on screen; its messages need no banner. */
let openThread: string | undefined;
let setup: Promise<boolean> | undefined;
const desktopTimers = new Map<string, ReturnType<typeof setTimeout>>();

if (isNative) {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const level = (n.request.content.data as { level?: string } | undefined)?.level;
      return {
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: level !== 'silent',
        shouldSetBadge: false,
      };
    },
  });
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    const id = typeof data.alertId === 'string' ? data.alertId : response.notification.request.identifier;
    openListeners.forEach((l) => l(id, data));
  });
}
desktop?.onNotificationClick((id) => openListeners.forEach((l) => l(id, {})));

export function onToast(listener: (t: Toast) => void): () => void {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}

/** An in-app banner that is not an alert, e.g. "saving failed". */
export function showToast(toast: Toast): void {
  toastListeners.forEach((l) => l(toast));
}

/** Called when the user taps a notification. */
export function onNotificationOpen(listener: (alertId: string, data: Record<string, unknown>) => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

/** The notification that launched the app from a cold start, once. */
export function takeLaunchNotification(): { alertId: string; data: Record<string, unknown> } | undefined {
  if (!isNative) return undefined;
  const response = Notifications.getLastNotificationResponse();
  if (!response) return undefined;
  Notifications.clearLastNotificationResponse();
  const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
  const alertId = typeof data.alertId === 'string' ? data.alertId : response.notification.request.identifier;
  return { alertId, data };
}

export function setOpenThread(thread: string | undefined): void {
  openThread = thread;
}

const ALARM_CHANNEL: Notifications.NotificationChannelInput = {
  name: 'Notfall und Pass-auf-mich-auf',
  description: 'Notrufe deiner Kontakte und abgelaufene Pass-auf-mich-auf-Zeiten. Kommt auch bei „Bitte nicht stören“.',
  importance: Notifications.AndroidImportance.MAX,
  bypassDnd: true,
  // A person in need must be seen, even on a locked screen.
  lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  vibrationPattern: [0, 800, 400, 800, 400, 800],
  enableVibrate: true,
  sound: 'default',
  audioAttributes: { usage: Notifications.AndroidAudioUsage.ALARM, contentType: Notifications.AndroidAudioContentType.SONIFICATION },
};
let alarmChannelId: Promise<string> | undefined;

/**
 * The Android channel for alarms. Android keeps `bypassDnd` only on channels created while the
 * user allows Heyda. to override Do Not Disturb, so once that is granted alarms move to a new
 * channel. The old one stays: alarms scheduled earlier still post to it.
 */
function alarmChannel(): Promise<string> {
  alarmChannelId ??= (async () => {
    if (Platform.OS !== 'android') return CHANNELS.alarm;
    const id = (await isDndAccessGranted()) ? CHANNELS.alarmDnd : CHANNELS.alarm;
    await Notifications.setNotificationChannelAsync(id, ALARM_CHANNEL);
    return id;
  })().catch(() => {
    alarmChannelId = undefined;
    return CHANNELS.alarm;
  });
  return alarmChannelId;
}

/** Re-checks Do Not Disturb access, e.g. when the user comes back from the system settings. */
export function refreshAlarmChannel(): void {
  alarmChannelId = undefined;
  if (isNative) void alarmChannel();
}

async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await alarmChannel();
  await Notifications.setNotificationChannelAsync(CHANNELS.normal, {
    name: 'Freunde',
    description: 'Nachrichten, Ankünfte und Check-ins.',
    importance: Notifications.AndroidImportance.HIGH,
    // Hide names and places on a locked screen.
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    sound: 'default',
  });
  await Notifications.setNotificationChannelAsync(CHANNELS.silent, {
    name: 'Leise',
    description: 'Während deiner Ruhezeit: erscheint ohne Ton.',
    importance: Notifications.AndroidImportance.LOW,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    sound: null,
    enableVibrate: false,
  });
}

/** Asks for permission once and sets up channels. Safe to call often. */
export function setupNotifications(): Promise<boolean> {
  setup ??= (async () => {
    if (!isNative) return desktop !== undefined;
    await ensureChannels();
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

export async function notificationsAllowed(): Promise<boolean> {
  if (!isNative) return desktop !== undefined;
  return (await Notifications.getPermissionsAsync()).granted;
}

function content(title: string, body: string, level: AlertLevel, data: Record<string, unknown>): Notifications.NotificationContentInput {
  return {
    title,
    body,
    data: { ...data, level },
    sound: level === 'silent' ? false : 'default',
    priority:
      level === 'alarm'
        ? Notifications.AndroidNotificationPriority.MAX
        : level === 'silent'
          ? Notifications.AndroidNotificationPriority.LOW
          : Notifications.AndroidNotificationPriority.HIGH,
    // Time-sensitive breaks through iOS Focus modes when the user allows it for this app.
    interruptionLevel: level === 'alarm' ? 'timeSensitive' : level === 'silent' ? 'passive' : 'active',
  };
}

async function channelFor(level: AlertLevel): Promise<string> {
  return level === 'alarm' ? alarmChannel() : level === 'silent' ? CHANNELS.silent : CHANNELS.normal;
}

/** Notification identifiers: alarm ids contain ":", which some platforms dislike in tags. */
function nid(id: string): string {
  return `h-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 120);
}

/**
 * Shows an alert by its level. In the open app a banner (and for alarms the alarm screen);
 * in the background a system notification. `feed` alerts only go to the activity list.
 */
export function deliverAlert(alert: Alert): void {
  if (alert.level === 'feed') return;
  const active = AppState.currentState === 'active' || !isNative;
  if (active && (alert.level === 'alarm' || !alert.thread || alert.thread !== openThread)) {
    const toast: Toast = { id: alert.id, title: alert.title, body: alert.body, level: alert.level, thread: alert.thread, alert };
    toastListeners.forEach((l) => l(toast));
  }
  if (desktop) {
    // Windows shows its own notification only when the window is not focused (see the shell).
    void desktop.notify({ id: alert.id, title: alert.title, body: alert.body, level: alert.level }).catch(() => {});
    if (alert.level === 'alarm') void desktop.attention().catch(() => {});
    return;
  }
  if (!isNative || active) return;
  void (async () => {
    if (!(await notificationsAllowed())) return;
    await Notifications.scheduleNotificationAsync({
      identifier: nid(alert.id),
      content: content(alert.title, alert.body, alert.level, { alertId: alert.id, thread: alert.thread ?? null }),
      trigger: Platform.OS === 'android' ? { channelId: await channelFor(alert.level) } : null,
    });
  })().catch(() => {});
}

/** A notification at a fixed time that fires even if the app is closed by then. */
export async function scheduleAlarm(alarm: Alarm, onDesktopFire?: (alarm: Alarm) => void): Promise<void> {
  if (alarm.level === 'feed') return;
  if (desktop || !isNative) {
    // The Windows app keeps running in the tray, so a timer is enough.
    const prev = desktopTimers.get(alarm.id);
    if (prev) clearTimeout(prev);
    const delay = Math.max(0, alarm.at - Date.now());
    if (delay > 2 ** 31 - 1) return;
    desktopTimers.set(
      alarm.id,
      setTimeout(() => {
        desktopTimers.delete(alarm.id);
        onDesktopFire?.(alarm);
      }, delay),
    );
    return;
  }
  if (!(await notificationsAllowed())) return;
  await Notifications.cancelScheduledNotificationAsync(nid(alarm.id)).catch(() => {});
  if (alarm.at <= Date.now()) return;
  await Notifications.scheduleNotificationAsync({
    identifier: nid(alarm.id),
    content: content(alarm.title, alarm.body, alarm.level, { alertId: alarm.id }),
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: alarm.at, channelId: await channelFor(alarm.level) },
  });
}

export async function cancelAlarm(id: string): Promise<void> {
  const t = desktopTimers.get(id);
  if (t) clearTimeout(t);
  desktopTimers.delete(id);
  if (!isNative) return;
  await Notifications.cancelScheduledNotificationAsync(nid(id)).catch(() => {});
  await Notifications.dismissNotificationAsync(nid(id)).catch(() => {});
}

export async function setBadge(count: number): Promise<void> {
  if (desktop) await desktop.setBadge(count).catch(() => {});
}
