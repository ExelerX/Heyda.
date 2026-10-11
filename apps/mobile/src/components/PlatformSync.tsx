import { useRootNavigationState, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { keepAliveSupported, setKeepAliveOnBoot, startKeepAlive, stopKeepAlive } from '../lib/keepalive';
import { onNotificationOpen, refreshAlarmChannel, setBadge, setupNotifications, takeLaunchNotification } from '../lib/notifications';
import { routeForNotification } from '../lib/routes';
import { useRuntime, useSnapshot } from '../lib/store';

/**
 * Keeps the operating system in step with the app: notification permission and channels,
 * the unread badge, the Android keep-alive service, and opening the right screen when a
 * notification is tapped (also when it launched the app).
 */
export function PlatformSync() {
  const runtime = useRuntime();
  const router = useRouter();
  const navReady = !!useRootNavigationState()?.key;
  const { settings, isDemo, unreadTotal } = useSnapshot();
  const onboarded = settings.onboarded;

  useEffect(() => {
    if (!onboarded || isDemo) return;
    void setupNotifications().catch(() => {});
    // Back from the system settings: Do Not Disturb access may have changed.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshAlarmChannel();
    });
    return () => sub.remove();
  }, [onboarded, isDemo]);

  useEffect(() => {
    void setBadge(unreadTotal);
  }, [unreadTotal]);

  const wantKeepAlive = keepAliveSupported && settings.keepAlive && onboarded && !isDemo;
  useEffect(() => {
    if (!keepAliveSupported) return;
    const apply = () => {
      if (wantKeepAlive) void startKeepAlive({ title: '', body: '' }).catch(() => {});
      else void stopKeepAlive().catch(() => {});
      void setKeepAliveOnBoot(wantKeepAlive).catch(() => {});
    };
    apply();
    // Android 12+ refuses to start it from the background: try again when the app is visible.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && wantKeepAlive) apply();
    });
    return () => sub.remove();
  }, [wantKeepAlive]);

  useEffect(() => {
    if (!navReady) return;
    const open = (alertId: string, data: Record<string, unknown>) => {
      const snap = runtime.getSnapshot();
      if (!snap.settings.onboarded) return;
      router.push(routeForNotification(alertId, data, snap.activity, snap.state.self.key));
    };
    const launch = takeLaunchNotification();
    if (launch) open(launch.alertId, launch.data);
    return onNotificationOpen(open);
  }, [navReady, router, runtime]);

  return null;
}
