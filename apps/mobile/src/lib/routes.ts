import type { Alert } from '@heyda/core';
import type { Href } from 'expo-router';

/** Where tapping an alert (in the activity list or as a notification) leads. */
export function routeForAlert(alert: Pick<Alert, 'category' | 'from' | 'thread' | 'ref'>, selfKey: string): Href {
  const owner = alert.ref?.sosOwner;
  if (owner === selfKey) return '/sos';
  if (owner) return { pathname: '/sos-alert/[key]', params: { key: owner } };
  if (alert.ref?.requestId && alert.category === 'where' && alert.from) {
    return { pathname: '/where/[key]', params: { key: alert.from, request: alert.ref.requestId } };
  }
  if (alert.category === 'device') return '/devices';
  if (alert.ref?.groupId) return { pathname: '/chat/[key]', params: { key: `g:${alert.ref.groupId}` } };
  if (alert.category === 'watch' && alert.from) return { pathname: '/contact/[key]', params: { key: alert.from } };
  if (alert.thread) return { pathname: '/chat/[key]', params: { key: alert.thread } };
  if (alert.from) return { pathname: '/contact/[key]', params: { key: alert.from } };
  return '/activity';
}

/**
 * Where a tapped system notification leads. Alerts are looked up in the activity list;
 * scheduled alarms carry their id ("watch:<from>:<id>" on a helper's phone, "mywatch:<id>:…" on mine).
 */
export function routeForNotification(alertId: string, data: Record<string, unknown>, activity: Alert[], selfKey: string): Href {
  const alert = activity.find((a) => a.id === alertId);
  if (alert) return routeForAlert(alert, selfKey);
  const watch = /^watch:([0-9a-f]{64}):/.exec(alertId);
  if (watch) return { pathname: '/contact/[key]', params: { key: watch[1] } };
  if (alertId.startsWith('mywatch:')) return '/watch';
  if (typeof data.thread === 'string' && /^(g:)?[0-9a-zA-Z_-]{1,64}$/.test(data.thread)) {
    return { pathname: '/chat/[key]', params: { key: data.thread } };
  }
  return '/activity';
}
