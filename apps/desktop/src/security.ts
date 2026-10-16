// Pure security helpers for the main process. No Electron imports, so everything here is unit-tested.
import path from 'node:path';
import type { DesktopNotification, NotificationLevel } from './contract';

export const APP_SCHEME = 'app';
export const APP_HOST = 'heyda';
export const APP_START_URL = `${APP_SCHEME}://${APP_HOST}/`;

/**
 * The UI is a static Expo web export: one external, deferred bundle and no inline scripts.
 * react-native-web injects styles at runtime, hence 'unsafe-inline' for styles only.
 * Relays are user-configurable wss: hosts; map tiles come from a user-configurable https: server.
 * No 'unsafe-eval' and no 'wasm-unsafe-eval': nothing in the bundle needs them on desktop.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' wss:",
  "media-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const MAX_VAULT_BYTES = 20 * 1024 * 1024;
export const MAX_SAVE_FILE_BYTES = MAX_VAULT_BYTES;
export const MAX_OPEN_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SECRET_CHARS = 4096;
export const MAX_BADGE_COUNT = 1_000_000;
/** Longer notification text is shortened to these lengths... */
export const MAX_NOTIFICATION_TITLE_CHARS = 256;
export const MAX_NOTIFICATION_BODY_CHARS = 2048;
/** ...and refused only above this one. */
export const MAX_NOTIFICATION_INPUT_CHARS = 16_384;

const VAULT_NAME = /^[a-z0-9-]{1,40}$/;
const SECRET_NAME = /^[a-z0-9.-]{1,60}$/;
const NOTIFICATION_LEVELS: ReadonlySet<NotificationLevel> = new Set(['alarm', 'normal', 'silent']);

/** Thrown for any IPC argument that does not match the bridge contract. */
export class InvalidArgumentError extends Error {
  constructor(what: string) {
    super(`invalid argument: ${what}`);
    this.name = 'InvalidArgumentError';
  }
}

// ---------------------------------------------------------------------------------------------
// Origins and permissions

/** True only for URLs on the app's own origin, app://heyda. */
export function isAppUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === `${APP_SCHEME}:` &&
    url.host === APP_HOST &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * Granted only to the app's own origin: notifications, and the clipboard for the "Einfügen" and
 * "Kopieren" buttons (pairing and linking codes; Chromium still requires a click to read it).
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write']);

export function isPermissionAllowed(permission: string, requestingUrl: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl);
}

// ---------------------------------------------------------------------------------------------
// Static file serving for app://heyda/

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function mimeTypeFor(fileName: string): string | undefined {
  return MIME_TYPES[path.extname(fileName).toLowerCase()];
}

export type WebTarget =
  | { kind: 'file'; path: string }
  | { kind: 'spa' } // client-side route: serve index.html
  | { kind: 'invalid' };

// Characters Windows does not allow in file names, plus anything that could change the meaning of a path.
const FORBIDDEN_SEGMENT_CHARS = /[\u0000-\u001f\u007f\\/:*?"<>|]/;
// Device names; Windows ignores the extension and spaces before it ("nul.txt", "CON .js").
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\..*)?$/i;

/**
 * Maps a URL pathname to a file below `root`. Paths with a known file extension are assets
 * (404 when missing); everything else is an expo-router route and gets index.html.
 */
export function resolveWebPath(root: string, pathname: string, p: typeof path = path): WebTarget {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    const segment = decodeSegment(raw);
    if (segment === null || !isSafeSegment(segment)) return { kind: 'invalid' };
    segments.push(segment);
  }
  const last = segments.at(-1);
  if (last === undefined) return { kind: 'file', path: p.join(root, 'index.html') };
  if (mimeTypeFor(last) === undefined) return { kind: 'spa' };

  // A device name (CON, NUL, COM1, ...) opens the device instead of a file on Windows, whatever the folder.
  if (segments.some((segment) => WINDOWS_RESERVED_NAME.test(segment))) return { kind: 'invalid' };

  const resolvedRoot = p.resolve(root);
  const full = p.resolve(resolvedRoot, ...segments);
  const relative = p.relative(resolvedRoot, full);
  if (relative === '' || p.isAbsolute(relative) || relative.split(p.sep)[0] === '..') return { kind: 'invalid' };
  return { kind: 'file', path: full };
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function isSafeSegment(segment: string): boolean {
  return (
    segment.length <= 255 &&
    segment !== '.' &&
    segment !== '..' &&
    !FORBIDDEN_SEGMENT_CHARS.test(segment) &&
    // Windows silently drops trailing dots and spaces, which would alias other files.
    !/[. ]$/.test(segment)
  );
}

// ---------------------------------------------------------------------------------------------
// IPC argument validation (sizes and patterns from the bridge contract)

export function expectArgCount(args: readonly unknown[], count: number): void {
  if (args.length !== count) throw new InvalidArgumentError(`expected ${count} argument(s), got ${args.length}`);
}

export function parseVaultName(value: unknown): string {
  if (typeof value !== 'string' || !VAULT_NAME.test(value)) throw new InvalidArgumentError('vault name');
  return value;
}

export function parseSecretName(value: unknown): string {
  if (typeof value !== 'string' || !SECRET_NAME.test(value)) throw new InvalidArgumentError('secret name');
  return value;
}

export function parseSecretValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_SECRET_CHARS) throw new InvalidArgumentError('secret value');
  return value;
}

export function parseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidArgumentError('boolean');
  return value;
}

export function parseBadgeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_BADGE_COUNT) {
    throw new InvalidArgumentError('badge count');
  }
  return value;
}

/** Standard-alphabet base64 with padding, decoded to at most `maxBytes`. */
export function parseBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length > base64Length(maxBytes) || !isBase64(value)) {
    throw new InvalidArgumentError('base64 data');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw new InvalidArgumentError('base64 data too large');
  return bytes;
}

export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

// A plain loop instead of a regex: inputs can be ~27 million characters long.
function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let i = 0; i < value.length - padding; i++) {
    if (!isBase64Char(value.charCodeAt(i))) return false;
  }
  return true;
}

function isBase64Char(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    (c >= 48 && c <= 57) || // 0-9
    c === 43 || // +
    c === 47 // /
  );
}

export function parseNotification(value: unknown): DesktopNotification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidArgumentError('notification');
  }
  const { id, title, body, level } = value as Record<string, unknown>;
  return {
    id: boundedString(id, 1, 128, 'notification id'),
    // Chat messages may be 4000 characters and become the body as they are. Shorten long text instead of
    // refusing it: a refused call means no notification at all, also for an urgent message.
    title: shortenText(boundedString(title, 1, MAX_NOTIFICATION_INPUT_CHARS, 'notification title'), MAX_NOTIFICATION_TITLE_CHARS),
    body: shortenText(boundedString(body, 0, MAX_NOTIFICATION_INPUT_CHARS, 'notification body'), MAX_NOTIFICATION_BODY_CHARS),
    level: parseLevel(level),
  };
}

/** Cuts `text` to at most `max` UTF-16 units, ending in "…", without splitting a surrogate pair. */
export function shortenText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1; // room for the ellipsis
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // a high surrogate whose partner would be cut off
  return `${text.slice(0, end)}…`;
}

function parseLevel(value: unknown): NotificationLevel {
  if (typeof value !== 'string' || !NOTIFICATION_LEVELS.has(value as NotificationLevel)) {
    throw new InvalidArgumentError('notification level');
  }
  return value as NotificationLevel;
}

function boundedString(value: unknown, min: number, max: number, what: string): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new InvalidArgumentError(what);
  return value;
}

// ---------------------------------------------------------------------------------------------
// External URLs

const PHONE = String.raw`\+?[0-9][0-9().-]{0,31}`;
const URI_TEXT = String.raw`[A-Za-z0-9%._~!$'()*+,;=:@/-]`;
const TEL_BODY = new RegExp(`^${PHONE}$`);
const SMS_BODY = new RegExp(`^(?:${PHONE}(?:,${PHONE}){0,19})?(?:\\?body=${URI_TEXT}{0,4000})?$`);
const GEO_BODY = new RegExp(
  String.raw`^(-?\d{1,2}(?:\.\d{1,12})?),(-?\d{1,3}(?:\.\d{1,12})?)(?:,-?\d{1,6}(?:\.\d{1,3})?)?` +
    String.raw`(?:;[a-z]{1,10}=[A-Za-z0-9.-]{1,20}){0,3}` +
    `(?:\\?q=${URI_TEXT}{0,500})?$`,
);
const MAX_URL_LENGTH = 4096;

/**
 * Returns the URL to hand to shell.openExternal, or throws. Only https:, tel:, sms: and geo: are
 * allowed; everything else (file:, custom protocol handlers, ...) could start arbitrary programs.
 */
export function parseExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new InvalidArgumentError('url');
  }
  if (/[\s\u0000-\u001f\u007f]/.test(value)) throw new InvalidArgumentError('url');
  const colon = value.indexOf(':');
  const scheme = value.slice(0, colon + 1).toLowerCase();
  const rest = value.slice(colon + 1);
  switch (scheme) {
    case 'https:':
      return parseHttpsUrl(value);
    case 'tel:':
      if (TEL_BODY.test(rest)) return `tel:${rest}`;
      break;
    case 'sms:':
      if (SMS_BODY.test(rest)) return `sms:${rest}`;
      break;
    case 'geo:':
      if (isValidGeo(rest)) return `geo:${rest}`;
      break;
  }
  throw new InvalidArgumentError('url');
}

function parseHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError('url');
  }
  // Credentials in a URL are a classic phishing trick (https://bank.example@evil.example/).
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') {
    throw new InvalidArgumentError('url');
  }
  return url.href;
}

function isValidGeo(rest: string): boolean {
  const match = GEO_BODY.exec(rest);
  if (!match) return false;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

// ---------------------------------------------------------------------------------------------
// Files and Windows toasts

export const DEFAULT_SAVE_NAME = 'heyda-backup';

/** Turns a renderer-suggested name into a plain file name that is valid on Windows. */
export function parseSuggestedFileName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255) throw new InvalidArgumentError('file name');
  const base = value.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .slice(0, 120)
    .replace(/^[. ]+|[. ]+$/g, '');
  return cleaned === '' || WINDOWS_RESERVED_NAME.test(cleaned) ? DEFAULT_SAVE_NAME : cleaned;
}

/** Escapes text for XML and drops characters XML 1.0 cannot represent. */
export function escapeXml(text: string): string {
  return text
    .replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Toast XML for SOS/overdue alarms. scenario="urgent" lets the toast break through Focus Assist on
 * Windows 11 (22H2+) when the user allows "important notifications"; older builds ignore it.
 */
export function urgentToastXml(title: string, body: string): string {
  return (
    '<toast scenario="urgent" duration="long">' +
    '<visual><binding template="ToastGeneric">' +
    `<text>${escapeXml(title)}</text>` +
    `<text>${escapeXml(body)}</text>` +
    '</binding></visual>' +
    '<audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="true"/>' +
    '</toast>'
  );
}
