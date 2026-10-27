/** Route params come from deep links and notifications: never trust them. */
export function contactKeyParam(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : undefined;
}
