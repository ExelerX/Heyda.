// The platform bridge from docs/ARCHITECTURE.md. Keep this file in sync with that document.
// The preload script may only `import type` from here: sandboxed preloads cannot require local files.

export type DesktopPlatform = 'win32' | 'darwin' | 'linux';
export type NotificationLevel = 'alarm' | 'normal' | 'silent';

export interface DesktopNotification {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
}

export interface HeydaDesktopBridge {
  readonly version: string;
  readonly platform: DesktopPlatform;

  vaultRead(name: string): Promise<string | null>;
  vaultWrite(name: string, dataB64: string): Promise<void>;
  vaultDelete(name: string): Promise<void>;

  secretGet(name: string): Promise<string | null>;
  secretSet(name: string, value: string): Promise<void>;
  secretDelete(name: string): Promise<void>;

  notify(n: DesktopNotification): Promise<void>;
  onNotificationClick(cb: (id: string) => void): () => void;
  attention(): Promise<void>;
  setBadge(count: number): Promise<void>;

  getAutostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;

  saveFile(suggestedName: string, dataB64: string): Promise<boolean>;
  openFile(): Promise<{ name: string; dataB64: string } | null>;

  openExternal(url: string): Promise<void>;
}

export type InvokeMethod = Exclude<keyof HeydaDesktopBridge, 'version' | 'platform' | 'onNotificationClick'>;

export const INVOKE_CHANNELS = {
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
} as const satisfies Record<InvokeMethod, `heyda:${string}`>;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[InvokeMethod];

/** Main → renderer: the user clicked the notification with this id. */
export const NOTIFICATION_CLICK_CHANNEL = 'heyda:notification-click';

/** Main passes the app version to the preload through `additionalArguments`. */
export const VERSION_ARG_PREFIX = '--heyda-version=';
