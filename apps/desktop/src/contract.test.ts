import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS, NOTIFICATION_CLICK_CHANNEL, SAVE_DONE_CHANNEL, SAVE_REQUEST_CHANNEL } from './contract';

const preloadSource = readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');

describe('bridge contract', () => {
  it('uses one distinct channel per method', () => {
    const channels = [...Object.values(INVOKE_CHANNELS), NOTIFICATION_CLICK_CHANNEL, SAVE_REQUEST_CHANNEL, SAVE_DONE_CHANNEL];
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('keeps the sandboxed preload free of runtime imports other than electron', () => {
    const runtimeImports = [...preloadSource.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(runtimeImports).toEqual(['electron']);
    expect(preloadSource).not.toMatch(/\brequire\(/);
  });

  it('exposes every contract method from the preload', () => {
    const methods = [...Object.keys(INVOKE_CHANNELS), 'onNotificationClick', 'onSaveRequest', 'version', 'platform'];
    for (const method of methods) expect(preloadSource, method).toMatch(new RegExp(`^\\s+${method}:`, 'm'));
    expect(preloadSource).toContain("exposeInMainWorld('heydaDesktop', bridge)");
  });

  it('answers every save request, also when saving failed', () => {
    // The shell waits for the answer before quitting (a few seconds at most).
    expect(preloadSource).toMatch(/allSettled/);
    expect(preloadSource).toContain('SAVE_DONE');
  });
});
