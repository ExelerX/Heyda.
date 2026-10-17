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
const doneListeners = new Set<(alarmId: string, at: number) => void>();
/** Alarms opened or swiped away before anyone listened (a launch in the background); handed on later. */
const doneBefore: { id: string; at: number }[] = [];
/**
 * iOS: alarm notifications in this category report being swiped away (cleared), so the app can
 * remember it, also when it was closed. No ":" or "-" in category ids.
 */
const ALARM_CATEGORY = 'heydaalarm';
const DISMISS_ACTION = 'com.apple.UNNotificationDismissActionIdentifier';
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
    // Opened or swiped away: an alarm among them must never ring again. Swiped away opens nothing.
    if (noteResponse(response)) return;
    // No screen to open yet (cold start, or the app restarting): takeLaunchNotification() hands it on.
    if (!openListeners.size) return;
    const tap = takeTap(response);
    if (!tap) return;
    // Expo keeps every tap as the "last response"; left there, the next takeLaunchNotification()
    // (after a restore, a link or the demo) would open this old screen again.
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      // Not available: takeTap() still never opens the same tap twice.
    }
    openListeners.forEach((l) => l(tap.alertId, tap.data));
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

/**
 * Called with the id of an alarm notification the person opened or swiped away (iOS reports the
 * latter), and when it was shown. Also those from before the listener was added.
 */
export function onAlarmDone(listener: (alarmId: string, at: number) => void): () => void {
  doneListeners.add(listener);
  for (const d of doneBefore.splice(0)) listener(d.id, d.at);
  return () => doneListeners.delete(listener);
}

/** Records a response to an alarm notification; true when it was swiped away rather than opened. */
function noteResponse(response: Notifications.NotificationResponse): boolean {
  const { request, date } = response.notification;
  const data = (request.content.data ?? {}) as Record<string, unknown>;
  const alertId = typeof data.alertId === 'string' ? data.alertId : request.identifier;
  if (/^(watch|mywatch):/.test(alertId)) {
    const at = postedAt(date);
    if (doneListeners.size) doneListeners.forEach((l) => l(alertId, at));
    else if (doneBefore.length < 50) doneBefore.push({ id: alertId, at });
  }
  return response.actionIdentifier === DISMISS_ACTION;
}

/** Called when the user taps a notification. */
export function onNotificationOpen(listener: (alertId: string, data: Record<string, unknown>) => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

/** The tap opened last. Expo can report one tap twice: as the launch response and as an event. */
let lastTap: string | undefined;

function takeTap(response: Notifications.NotificationResponse): { alertId: string; data: Record<string, unknown> } | undefined {
  const { request, date } = response.notification;
  const key = `${request.identifier}|${date}|${response.actionIdentifier}`;
  if (key === lastTap) return undefined;
  lastTap = key;
  const data = (request.content.data ?? {}) as Record<string, unknown>;
  const alertId = typeof data.alertId === 'string' ? data.alertId : request.identifier;
  return { alertId, data };
}

/** A tap not opened yet: the one that launched the app, or one made while the app was restarting. */
export function takeLaunchNotification(): { alertId: string; data: Record<string, unknown> } | undefined {
  if (!isNative) return undefined;
  const response = Notifications.getLastNotificationResponse();
  if (!response) return undefined;
  Notifications.clearLastNotificationResponse();
  if (noteResponse(response)) return undefined;
  return takeTap(response);
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
    if (Platform.OS === 'ios') {
      await Notifications.setNotificationCategoryAsync(ALARM_CATEGORY, [], { customDismissAction: true }).catch(() => {});
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

export async function notificationsAllowed(): Promise<boolean> {
  if (!isNative) return desktop !== undefined;
  return (await Notifications.getPermissionsAsync()).granted;
}

/** `alarm`: one of the alarms the app keeps track of (see `ALARM_CATEGORY`). */
function content(title: string, body: string, level: AlertLevel, data: Record<string, unknown>, alarm = false): Notifications.NotificationContentInput {
  return {
    title,
    body,
    data: { ...data, level },
    ...(alarm && Platform.OS === 'ios' ? { categoryIdentifier: ALARM_CATEGORY } : {}),
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
 * The native calls for one alarm, one after another. Each call waits for the OS several times
 * (permission, channel), so without this a cancel that follows a schedule closely (a watch and
 * its end arriving together after the phone was offline) would reach the OS first, and the
 * alarm would ring later for a watch that had already ended.
 */
const alarmCalls = new Map<string, Promise<void>>();

function inOrder(identifier: string, call: () => Promise<void>): Promise<void> {
  const run = (alarmCalls.get(identifier) ?? Promise.resolve()).then(call);
  const done = run.catch(() => {});
  alarmCalls.set(identifier, done);
  void done.then(() => {
    if (alarmCalls.get(identifier) === done) alarmCalls.delete(identifier);
  });
  return run;
}

/** When this JS context started. A restart of the phone or an app update since would have ended it. */
const STARTED_AT = Date.now();

/**
 * Whether the OS already rang the alarm with this identifier, due at `at` (undefined: the OS
 * never got it). One that has not rung yet is cancelled: the caller shows the alert now instead,
 * and the alarm must not ring a second time a moment later.
 */
async function alarmRang(identifier: string, at: number | undefined): Promise<boolean> {
  const pending = await Notifications.getAllScheduledNotificationsAsync().catch(() => undefined);
  if (!pending || pending.some((n) => n.identifier === identifier)) {
    await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
    return false;
  }
  if (at === undefined) return false;
  // Gone from the OS's list: it rang, and may have been swiped away since. Only when the phone
  // restarted (or the app was updated) after its time does Android drop it without ringing, and
  // both end this process: one running since before its time saw it ring.
  if (STARTED_AT < at) return true;
  // Started later: only a notification still on screen tells (not an older ring of the same watch).
  const shown = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  return shown.some((n) => n.request.identifier === identifier && postedAt(n.date) >= at - 5_000);
}

/** Android reports milliseconds, iOS seconds. */
function postedAt(date: number): number {
  return date < 1e11 ? date * 1000 : date;
}

/**
 * Shows an alert by its level. In the open app a banner (and for alarms the alarm screen);
 * in the background a system notification. `feed` alerts only go to the activity list.
 *
 * `alarmAt` is for an alert with the id of an alarm handed to the OS earlier (a contact's overdue
 * watch): it returns when that alarm was due, or undefined if the OS never got it. The two then
 * ring once, whichever comes first. `shown`: the app knows the OS showed that alarm already (it
 * may have been opened or swiped away since): then no system notification at all.
 */
export function deliverAlert(alert: Alert, alarmAt?: () => number | undefined, shown = false): void {
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
  if (!isNative || (active && !alarmAt)) return;
  const identifier = nid(alert.id);
  // In the same queue as the alarm: a schedule still on its way to the OS counts.
  void inOrder(identifier, async () => {
    // Checked also when shown: one still waiting with the OS is cancelled there.
    if (alarmAt && ((await alarmRang(identifier, alarmAt())) || shown)) return;
    if (active || !(await notificationsAllowed())) return;
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: content(alert.title, alert.body, alert.level, { alertId: alert.id, thread: alert.thread ?? null }, !!alarmAt),
      trigger: Platform.OS === 'android' ? { channelId: await channelFor(alert.level) } : null,
    });
  }).catch(() => {});
}

/**
 * A notification at a fixed time that fires even if the app is closed by then. `onScheduled`
 * runs once the OS has it.
 */
export async function scheduleAlarm(alarm: Alarm, onDesktopFire?: (alarm: Alarm) => void, onScheduled?: () => void): Promise<void> {
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
  const identifier = nid(alarm.id);
  return inOrder(identifier, async () => {
    if (!(await notificationsAllowed())) return;
    await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
    if (alarm.at <= Date.now()) return;
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: content(alarm.title, alarm.body, alarm.level, { alertId: alarm.id }, true),
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: alarm.at, channelId: await channelFor(alarm.level) },
    });
    // Still in this alarm's queue, so an alert for it that follows already knows.
    onScheduled?.();
  });
}

export async function cancelAlarm(id: string): Promise<void> {
  const t = desktopTimers.get(id);
  if (t) clearTimeout(t);
  desktopTimers.delete(id);
  if (!isNative) return;
  const identifier = nid(id);
  return inOrder(identifier, async () => {
    await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
    await Notifications.dismissNotificationAsync(identifier).catch(() => {});
  });
}

/**
 * Which of these alarms, handed to the OS and due by now, it has rung as far as can be told: gone
 * from its list while this process ran past their time, or still on screen. The caller remembers
 * them, since once one is swiped away nothing tells any more. (Gone before Heyda ran again and not
 * on screen: Android does not say whether it was swiped away or dropped unrung, the phone being off.)
 */
export async function alarmsRang<A extends Alarm>(alarms: readonly A[]): Promise<A[]> {
  if (!isNative || desktop || !alarms.length) return [];
  const pending = await Notifications.getAllScheduledNotificationsAsync().catch(() => undefined);
  if (!pending) return [];
  const waiting = new Set(pending.map((n) => n.identifier));
  const shown = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  return alarms.filter((a) => {
    const identifier = nid(a.id);
    if (waiting.has(identifier) || alarmCalls.has(identifier)) return false;
    return STARTED_AT < a.at || shown.some((n) => n.request.identifier === identifier && postedAt(n.date) >= a.at - 5_000);
  });
}

/** Alarm ids as the OS knows them: only these are ever pruned. */
const ALARM_PREFIXES = [nid('watch:'), nid('mywatch:')];

/**
 * Cancels alarms the OS still holds but the app no longer knows, e.g. from before a restore, a
 * link or the demo, or because the app was closed between the two. `known` returns undefined
 * when its list may be incomplete; then nothing is touched.
 */
export async function pruneAlarms(known: () => readonly Alarm[] | undefined): Promise<void> {
  if (!isNative || desktop) return;
  const pending = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  const stale = pending.map((n) => n.identifier).filter((id) => ALARM_PREFIXES.some((p) => id.startsWith(p)));
  await Promise.all(
    stale.map((identifier) =>
      inOrder(identifier, async () => {
        // Checked only now: the alarm may have been scheduled again while the list was read.
        const list = known();
        if (!list || list.some((a) => nid(a.id) === identifier)) return;
        await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
      }),
    ),
  );
}

/**
 * Removes everything the app left with the OS: scheduled alarms and notifications still on
 * screen, which show names and message previews. For when the account on this device is wiped
 * or replaced; nothing in the new data could cancel them. The keep-alive notification stays.
 */
export async function clearNotifications(): Promise<void> {
  for (const t of desktopTimers.values()) clearTimeout(t);
  desktopTimers.clear();
  if (desktop) await desktop.setBadge(0).catch(() => {});
  if (!isNative) return;
  // Calls still on their way to the OS go first, so none of them lands afterwards.
  await Promise.all([...alarmCalls.values()]);
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  await Notifications.dismissAllNotificationsAsync().catch(() => {});
}

export async function setBadge(count: number): Promise<void> {
  if (desktop) await desktop.setBadge(count).catch(() => {});
}
