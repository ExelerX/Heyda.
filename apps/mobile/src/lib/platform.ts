import { Platform } from 'react-native';

/** The object the Windows app's preload script puts on `window` (see docs/ARCHITECTURE.md). */
export interface HeydaDesktopBridge {
  readonly version: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  vaultRead(name: string): Promise<string | null>;
  vaultWrite(name: string, dataB64: string): Promise<void>;
  vaultDelete(name: string): Promise<void>;
  secretGet(name: string): Promise<string | null>;
  secretSet(name: string, value: string): Promise<void>;
  secretDelete(name: string): Promise<void>;
  notify(n: { id: string; title: string; body: string; level: 'alarm' | 'normal' | 'silent' }): Promise<void>;
  onNotificationClick(cb: (id: string) => void): () => void;
  attention(): Promise<void>;
  setBadge(count: number): Promise<void>;
  getAutostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;
  saveFile(suggestedName: string, dataB64: string): Promise<boolean>;
  openFile(): Promise<{ name: string; dataB64: string } | null>;
  openExternal(url: string): Promise<void>;
}

declare global {
  interface Window {
    heydaDesktop?: HeydaDesktopBridge;
  }
}

export const desktop: HeydaDesktopBridge | undefined =
  Platform.OS === 'web' && typeof window !== 'undefined' ? window.heydaDesktop : undefined;

/** Running inside the Windows app. */
export const isDesktop = desktop !== undefined;
/** Android or iOS. */
export const isNative = Platform.OS === 'android' || Platform.OS === 'ios';
/** A plain browser (preview only): demo mode, nothing stored. */
export const isBrowserPreview = Platform.OS === 'web' && !isDesktop;

export function deviceLabel(): string {
  if (isDesktop) return desktop!.platform === 'win32' ? 'Windows-PC' : 'Computer';
  if (Platform.OS === 'ios') return 'iPhone';
  if (Platform.OS === 'android') return 'Android-Handy';
  return 'Browser';
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
