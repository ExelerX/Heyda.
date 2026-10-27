import type { Alert } from '@heyda/core';
import type { Href } from 'expo-router';
import { routeForAlert } from '../../lib/routes';

/**
 * Where tapping a banner or the alarm screen leads. Like `routeForAlert`, plus my own
 * "Pass auf mich auf" reminders (ids "mywatch:<id>:…", fired by the Windows app's timers),
 * which carry no sender and would otherwise end up in the activity list.
 */
export function routeForToast(alert: Alert | undefined, selfKey: string): Href {
  if (!alert) return '/activity';
  if (alert.id.startsWith('mywatch:')) return '/watch';
  return routeForAlert(alert, selfKey);
}

/** The watch id of my own "time is up" alarm ("mywatch:<id>:due"), if this is one. */
export function myWatchDue(alertId: string): string | undefined {
  const m = /^mywatch:([A-Za-z0-9_-]{1,64}):due$/.exec(alertId);
  return m?.[1];
}
