/** Route params come from deep links and notifications: never trust them. */

export const CONTACT_KEY = /^[0-9a-f]{64}$/;
export const ITEM_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** First value of a search param, or undefined. */
export function param(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length <= 200 ? s : undefined;
}

export function contactKeyParam(v: string | string[] | undefined): string | undefined {
  const s = param(v);
  return s && CONTACT_KEY.test(s) ? s : undefined;
}

export function idParam(v: string | string[] | undefined): string | undefined {
  const s = param(v);
  return s && ITEM_ID.test(s) ? s : undefined;
}

export type Thread = { kind: 'contact'; key: string } | { kind: 'group'; id: string };

/** A chat thread: a contact key, or "g:" plus a group id. */
export function threadParam(v: string | string[] | undefined): Thread | undefined {
  const s = param(v);
  if (!s) return undefined;
  if (CONTACT_KEY.test(s)) return { kind: 'contact', key: s };
  if (s.startsWith('g:') && ITEM_ID.test(s.slice(2))) return { kind: 'group', id: s.slice(2) };
  return undefined;
}
