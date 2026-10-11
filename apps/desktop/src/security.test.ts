import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  DEFAULT_SAVE_NAME,
  InvalidArgumentError,
  MAX_SECRET_CHARS,
  escapeXml,
  expectArgCount,
  isAppUrl,
  isPermissionAllowed,
  mimeTypeFor,
  parseBadgeCount,
  parseBase64,
  parseBoolean,
  parseExternalUrl,
  parseNotification,
  parseSecretName,
  parseSecretValue,
  parseSuggestedFileName,
  parseVaultName,
  resolveWebPath,
  urgentToastXml,
} from './security';

describe('isAppUrl', () => {
  it('accepts only the app://heyda origin', () => {
    expect(isAppUrl('app://heyda/')).toBe(true);
    expect(isAppUrl('app://heyda')).toBe(true);
    expect(isAppUrl('app://heyda/chat/abc?x=1#y')).toBe(true);
    expect(isAppUrl('app://evil/')).toBe(false);
    expect(isAppUrl('app://heyda.evil/')).toBe(false);
    expect(isAppUrl('app://heyda:8080/')).toBe(false);
    expect(isAppUrl('app://user:pw@heyda/')).toBe(false);
    expect(isAppUrl('https://heyda/')).toBe(false);
    expect(isAppUrl('file:///C:/heyda/index.html')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
    expect(isAppUrl('')).toBe(false);
  });
});

describe('isPermissionAllowed', () => {
  it('grants notifications to the app origin and nothing else', () => {
    expect(isPermissionAllowed('notifications', 'app://heyda')).toBe(true);
    expect(isPermissionAllowed('notifications', 'app://heyda/')).toBe(true);
    expect(isPermissionAllowed('notifications', 'https://example.com')).toBe(false);
    for (const permission of ['media', 'geolocation', 'clipboard-read', 'openExternal', 'hid', 'fullscreen']) {
      expect(isPermissionAllowed(permission, 'app://heyda/')).toBe(false);
    }
  });
});

describe('CONTENT_SECURITY_POLICY', () => {
  const directives = new Map(
    CONTENT_SECURITY_POLICY.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values] as const;
    }),
  );

  it('allows no inline or evaluated scripts and no remote scripts', () => {
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });

  it('allows wss relays and https map tiles, nothing broader', () => {
    expect(directives.get('connect-src')).toEqual(["'self'", 'wss:']);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:']);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
  });
});

describe('mimeTypeFor', () => {
  it('knows the types the Expo export uses', () => {
    expect(mimeTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(mimeTypeFor('index-7df3e7ea.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeTypeFor('icon@2x.PNG')).toBe('image/png');
    expect(mimeTypeFor('favicon.ico')).toBe('image/x-icon');
    expect(mimeTypeFor('metadata.json')).toBe('application/json; charset=utf-8');
    expect(mimeTypeFor('font.woff2')).toBe('font/woff2');
    expect(mimeTypeFor('route')).toBeUndefined();
    expect(mimeTypeFor('npub1abc.xyz')).toBeUndefined();
  });
});

describe('resolveWebPath', () => {
  const root = path.resolve('/srv/web');

  it('serves index.html for the root', () => {
    expect(resolveWebPath(root, '/')).toEqual({ kind: 'file', path: path.join(root, 'index.html') });
    expect(resolveWebPath(root, '')).toEqual({ kind: 'file', path: path.join(root, 'index.html') });
  });

  it('maps assets below the root', () => {
    expect(resolveWebPath(root, '/_expo/static/js/web/index-abc.js')).toEqual({
      kind: 'file',
      path: path.join(root, '_expo', 'static', 'js', 'web', 'index-abc.js'),
    });
    expect(resolveWebPath(root, '/assets/__node_modules/x/back-icon@2x.png')).toEqual({
      kind: 'file',
      path: path.join(root, 'assets', '__node_modules', 'x', 'back-icon@2x.png'),
    });
    expect(resolveWebPath(root, '/assets/a%20b.png')).toEqual({ kind: 'file', path: path.join(root, 'assets', 'a b.png') });
  });

  it('falls back to the SPA for client-side routes', () => {
    expect(resolveWebPath(root, '/chat/3f2a')).toEqual({ kind: 'spa' });
    expect(resolveWebPath(root, '/contact/npub1.xyz')).toEqual({ kind: 'spa' });
    expect(resolveWebPath(root, '/assets')).toEqual({ kind: 'spa' });
  });

  it('rejects traversal and Windows path tricks', () => {
    for (const evil of [
      '/../secret.js',
      '/%2e%2e/secret.js',
      '/assets/..%2f..%2fsecret.js',
      '/assets/..%5c..%5csecret.js',
      '/C:%5cWindows%5cwin.ini',
      '/assets/x.js%00.png',
      '/assets/file.js.',
      '/assets/file.js%20',
      '/assets/file.js::$DATA',
      '/%E0%A4%A',
      '/./index.html',
    ]) {
      expect(resolveWebPath(root, evil), evil).toEqual({ kind: 'invalid' });
    }
  });

  it('keeps Windows paths inside the root', () => {
    const winRoot = 'C:\\Program Files\\Heyda\\resources\\app.asar\\web';
    expect(resolveWebPath(winRoot, '/_expo/a.js', path.win32)).toEqual({
      kind: 'file',
      path: 'C:\\Program Files\\Heyda\\resources\\app.asar\\web\\_expo\\a.js',
    });
    expect(resolveWebPath(winRoot, '/..%5c..%5capp.js', path.win32)).toEqual({ kind: 'invalid' });
    expect(resolveWebPath(winRoot, '/D:%5capp.js', path.win32)).toEqual({ kind: 'invalid' });
  });
});

describe('IPC argument validation', () => {
  it('checks the argument count', () => {
    expect(() => expectArgCount([1], 1)).not.toThrow();
    expect(() => expectArgCount([1, 2], 1)).toThrow(InvalidArgumentError);
    expect(() => expectArgCount([], 1)).toThrow(InvalidArgumentError);
  });

  it('validates vault names', () => {
    expect(parseVaultName('state')).toBe('state');
    expect(parseVaultName('a'.repeat(40))).toBe('a'.repeat(40));
    for (const bad of ['', 'a'.repeat(41), 'State', 'a.b', '../x', 'a/b', 'a b', 1, null, undefined, ['a']]) {
      expect(() => parseVaultName(bad), String(bad)).toThrow(InvalidArgumentError);
    }
  });

  it('validates secret names and values', () => {
    expect(parseSecretName('nostr.key-1')).toBe('nostr.key-1');
    for (const bad of ['', 'a'.repeat(61), 'Key', 'a/b', 'a\\b', 'a_b', 42]) {
      expect(() => parseSecretName(bad), String(bad)).toThrow(InvalidArgumentError);
    }
    expect(parseSecretValue('x'.repeat(MAX_SECRET_CHARS))).toHaveLength(MAX_SECRET_CHARS);
    expect(parseSecretValue('')).toBe('');
    expect(() => parseSecretValue('x'.repeat(MAX_SECRET_CHARS + 1))).toThrow(InvalidArgumentError);
    expect(() => parseSecretValue({})).toThrow(InvalidArgumentError);
  });

  it('validates base64 strictly and enforces the size limit', () => {
    expect(parseBase64('aGV5ZGE=', 10).toString()).toBe('heyda');
    expect(parseBase64('', 10)).toHaveLength(0);
    expect(parseBase64(Buffer.alloc(30).toString('base64'), 30)).toHaveLength(30);
    expect(() => parseBase64(Buffer.alloc(31).toString('base64'), 30)).toThrow(InvalidArgumentError);
    for (const bad of ['aGV5ZGE', 'aGV5 ZGE=', 'aGV5ZGE-', 'aGV5ZG_=', '====', 'a===', null, 5]) {
      expect(() => parseBase64(bad, 100), String(bad)).toThrow(InvalidArgumentError);
    }
  });

  it('validates notifications', () => {
    const ok = { id: 'n1', title: 'SOS', body: 'Lisa braucht Hilfe', level: 'alarm' };
    expect(parseNotification(ok)).toEqual(ok);
    expect(parseNotification({ ...ok, extra: 'ignored' })).toEqual(ok);
    for (const bad of [
      null,
      [],
      'x',
      { ...ok, id: '' },
      { ...ok, id: 'x'.repeat(129) },
      { ...ok, title: '' },
      { ...ok, body: 'x'.repeat(2049) },
      { ...ok, level: 'loud' },
      { ...ok, level: undefined },
    ]) {
      expect(() => parseNotification(bad), JSON.stringify(bad)).toThrow(InvalidArgumentError);
    }
  });

  it('validates badge counts and booleans', () => {
    expect(parseBadgeCount(0)).toBe(0);
    expect(parseBadgeCount(12)).toBe(12);
    for (const bad of [-1, 1.5, Number.NaN, Infinity, '3', 2_000_000]) {
      expect(() => parseBadgeCount(bad), String(bad)).toThrow(InvalidArgumentError);
    }
    expect(parseBoolean(true)).toBe(true);
    expect(() => parseBoolean('true')).toThrow(InvalidArgumentError);
  });
});

describe('parseExternalUrl', () => {
  it('allows https and normalizes it', () => {
    expect(parseExternalUrl('https://www.openstreetmap.org/copyright')).toBe('https://www.openstreetmap.org/copyright');
    expect(parseExternalUrl('HTTPS://Example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
  });

  it('allows tel, sms and geo in their expected shapes', () => {
    expect(parseExternalUrl('tel:+49301234567')).toBe('tel:+49301234567');
    expect(parseExternalUrl('sms:+49301234567')).toBe('sms:+49301234567');
    expect(parseExternalUrl('sms:+4930123,+4930456?body=Ich%20brauche%20Hilfe')).toBe(
      'sms:+4930123,+4930456?body=Ich%20brauche%20Hilfe',
    );
    expect(parseExternalUrl('geo:52.52,13.405')).toBe('geo:52.52,13.405');
    expect(parseExternalUrl('geo:52.52,13.405;u=35?q=52.52,13.405(Lisa)')).toBe('geo:52.52,13.405;u=35?q=52.52,13.405(Lisa)');
  });

  it('refuses everything else', () => {
    for (const bad of [
      'http://example.com',
      'file:///C:/Windows/System32/calc.exe',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x',
      'javascript:alert(1)',
      'app://heyda/',
      'https://user:pw@example.com/',
      'https://bank.example@evil.example/',
      'https://',
      'https://example.com/a b',
      'https://example.com/\n',
      'tel:+49 30 123',
      'tel:0301234567;ext=1&x',
      'sms:+4930123?body=a&cc=b',
      'geo:91,13',
      'geo:52.5,181',
      'geo:52.5',
      'mailto:a@example.com',
      '',
      'x'.repeat(5000),
      42,
      null,
    ]) {
      expect(() => parseExternalUrl(bad), String(bad)).toThrow(InvalidArgumentError);
    }
  });
});

describe('parseSuggestedFileName', () => {
  it('keeps normal names', () => {
    expect(parseSuggestedFileName('heyda-backup-2026-10-11.heyda')).toBe('heyda-backup-2026-10-11.heyda');
    expect(parseSuggestedFileName('Backup Lisa.json')).toBe('Backup Lisa.json');
  });

  it('strips directories and characters Windows forbids', () => {
    expect(parseSuggestedFileName('..\\..\\Windows\\evil.exe')).toBe('evil.exe');
    expect(parseSuggestedFileName('../../etc/passwd')).toBe('passwd');
    expect(parseSuggestedFileName('a<b>c:d"e|f?g*h.txt')).toBe('abcdefgh.txt');
    expect(parseSuggestedFileName('name.txt. . ')).toBe('name.txt');
  });

  it('falls back for empty or reserved names', () => {
    for (const name of ['', '...', 'CON', 'nul.txt', 'com1', 'LPT9.json', '/']) {
      expect(parseSuggestedFileName(name), name).toBe(DEFAULT_SAVE_NAME);
    }
    expect(() => parseSuggestedFileName('x'.repeat(256))).toThrow(InvalidArgumentError);
    expect(() => parseSuggestedFileName(undefined)).toThrow(InvalidArgumentError);
  });
});

describe('Windows toast XML', () => {
  it('escapes markup and drops characters XML cannot carry', () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;');
    expect(escapeXml('a\u0000b\u0007c\nd 🚨')).toBe('abc\nd 🚨');
  });

  it('builds an urgent toast with the escaped text', () => {
    const xml = urgentToastXml('SOS von Lisa', 'Ort: <unbekannt> & "jetzt"');
    expect(xml).toContain('scenario="urgent"');
    expect(xml).toContain('<text>SOS von Lisa</text>');
    expect(xml).toContain('<text>Ort: &lt;unbekannt&gt; &amp; &quot;jetzt&quot;</text>');
    expect(xml).not.toContain('<unbekannt>');
  });
});
