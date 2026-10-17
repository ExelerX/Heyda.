// Sandboxed preload: exposes exactly the HeydaDesktopBridge as window.heydaDesktop.
// Sandboxed preloads can only require 'electron' (and a few Node built-ins), so everything from
// ./contract is imported as types; the literals below are checked against it at compile time.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  DesktopPlatform,
  HeydaDesktopBridge,
  INVOKE_CHANNELS,
  NOTIFICATION_CLICK_CHANNEL,
  SAVE_DONE_CHANNEL,
  SAVE_REQUEST_CHANNEL,
  VERSION_ARG_PREFIX,
} from './contract';

const CHANNELS: typeof INVOKE_CHANNELS = {
  vaultRead: 'heyda:vault-read',
  vaultWrite: 'heyda:vault-write',
  vaultDelete: 'heyda:vault-delete',
  secretGet: 'heyda:secret-get',
  secretSet: 'heyda:secret-set',
  secretDelete: 'heyda:secret-delete',
  notify: 'heyda:notify',
  attention: 'heyda:attention',
  setBadge: 'heyda:set-badge',
  getAutostart: 'heyda:get-autostart',
  setAutostart: 'heyda:set-autostart',
  saveFile: 'heyda:save-file',
  openFile: 'heyda:open-file',
  openExternal: 'heyda:open-external',
};
const CLICK_CHANNEL: typeof NOTIFICATION_CLICK_CHANNEL = 'heyda:notification-click';
const SAVE_REQUEST: typeof SAVE_REQUEST_CHANNEL = 'heyda:save-request';
const SAVE_DONE: typeof SAVE_DONE_CHANNEL = 'heyda:save-done';
const VERSION_PREFIX: typeof VERSION_ARG_PREFIX = '--heyda-version=';

// Clicks that arrive before the UI subscribed (e.g. right after a hidden autostart) are kept briefly.
const MAX_PENDING_CLICKS = 20;
const clickListeners = new Set<(id: string) => void>();
const pendingClicks: string[] = [];

ipcRenderer.on(CLICK_CHANNEL, (_event: IpcRendererEvent, id: unknown) => {
  if (typeof id !== 'string') return;
  if (clickListeners.size === 0) {
    pendingClicks.push(id);
    if (pendingClicks.length > MAX_PENDING_CLICKS) pendingClicks.shift();
    return;
  }
  for (const listener of clickListeners) deliverClick(listener, id);
});

// The shell asks for a save (window to the tray, quitting, Windows shutting down) and waits for the
// answer before it quits: it always comes, also when a listener failed or none is there yet.
const saveListeners = new Set<() => Promise<void> | void>();

ipcRenderer.on(SAVE_REQUEST, (_event: IpcRendererEvent, id: unknown) => {
  if (typeof id !== 'number') return;
  const runs = [...saveListeners].map((listener) => Promise.resolve().then(listener));
  void Promise.allSettled(runs).then(() => invoke(SAVE_DONE, id).catch(() => undefined));
});

function deliverClick(listener: (id: string) => void, id: string): void {
  try {
    listener(id);
  } catch (error) {
    console.error('notification click listener failed', error);
  }
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function appVersion(): string {
  const arg = process.argv.find((a) => a.startsWith(VERSION_PREFIX));
  return arg?.slice(VERSION_PREFIX.length) ?? '0.0.0';
}

function desktopPlatform(): DesktopPlatform {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}

const bridge: HeydaDesktopBridge = {
  version: appVersion(),
  platform: desktopPlatform(),

  vaultRead: (name) => invoke(CHANNELS.vaultRead, name),
  vaultWrite: (name, dataB64) => invoke(CHANNELS.vaultWrite, name, dataB64),
  vaultDelete: (name) => invoke(CHANNELS.vaultDelete, name),

  secretGet: (name) => invoke(CHANNELS.secretGet, name),
  secretSet: (name, value) => invoke(CHANNELS.secretSet, name, value),
  secretDelete: (name) => invoke(CHANNELS.secretDelete, name),

  notify: (n) => invoke(CHANNELS.notify, n),
  onNotificationClick: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onNotificationClick expects a function');
    clickListeners.add(cb);
    for (const id of pendingClicks.splice(0)) deliverClick(cb, id);
    return () => {
      clickListeners.delete(cb);
    };
  },
  attention: () => invoke(CHANNELS.attention),
  setBadge: (count) => invoke(CHANNELS.setBadge, count),

  onSaveRequest: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onSaveRequest expects a function');
    saveListeners.add(cb);
    return () => {
      saveListeners.delete(cb);
    };
  },

  getAutostart: () => invoke(CHANNELS.getAutostart),
  setAutostart: (on) => invoke(CHANNELS.setAutostart, on),

  saveFile: (suggestedName, dataB64) => invoke(CHANNELS.saveFile, suggestedName, dataB64),
  openFile: () => invoke(CHANNELS.openFile),

  openExternal: (url) => invoke(CHANNELS.openExternal, url),
};

contextBridge.exposeInMainWorld('heydaDesktop', bridge);
