import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './security';
import { createWebHandler } from './web-handler';

const INDEX = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';
const BUNDLE = 'console.log("heyda")';
let dir: string;
let root: string;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'heyda-web-'));
  root = path.join(dir, 'web');
  await mkdir(path.join(root, '_expo', 'static', 'js', 'web'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), INDEX);
  await writeFile(path.join(root, '_expo', 'static', 'js', 'web', 'index-abc.js'), BUNDLE);
  await writeFile(path.join(dir, 'secret.js'), 'outside');
  handler = createWebHandler(root);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const get = (url: string, method = 'GET') => handler(new Request(url, { method }));

describe('createWebHandler', () => {
  it('serves index.html with the CSP header', async () => {
    const response = await get('app://heyda/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe(INDEX);
  });

  it('serves bundles with a JavaScript MIME type', async () => {
    const response = await get('app://heyda/_expo/static/js/web/index-abc.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await response.text()).toBe(BUNDLE);
  });

  it('answers client-side routes with index.html', async () => {
    for (const url of ['app://heyda/chat/abc', 'app://heyda/contact/1f2e?tab=x', 'app://heyda/settings/']) {
      const response = await get(url);
      expect(response.status, url).toBe(200);
      expect(await response.text()).toBe(INDEX);
    }
  });

  it('returns 404 for missing assets instead of index.html', async () => {
    const response = await get('app://heyda/_expo/static/js/web/missing.js');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  });

  it('never serves files outside the web root', async () => {
    for (const url of ['app://heyda/..%2fsecret.js', 'app://heyda/%2e%2e%2fsecret.js', 'app://heyda/..%5csecret.js']) {
      const response = await get(url);
      expect(response.status, url).toBe(400);
      expect(await response.text()).not.toContain('outside');
    }
    // The URL parser itself resolves plain dot segments, so this stays inside the root.
    expect((await get('app://heyda/../secret.js')).status).toBe(404);
  });

  it('rejects other hosts and methods', async () => {
    expect((await get('app://other/index.html')).status).toBe(404);
    expect((await get('app://heyda/', 'POST')).status).toBe(405);
  });

  it('answers HEAD without a body', async () => {
    const response = await get('app://heyda/', 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('');
  });

  it('explains a missing UI build', async () => {
    const empty = createWebHandler(path.join(dir, 'nothing-here'));
    const response = await empty(new Request('app://heyda/'));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('prepare-web');
  });
});
