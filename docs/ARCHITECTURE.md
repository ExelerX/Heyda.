# Heyda. architecture (v1)

Developer notes. User-facing docs are in the README.

## Layout

```
packages/core              Platform-free logic: protocol, privacy gate, trips, live location, SOS, watches,
                           groups, do-not-disturb, automations, device sync. No React, no Expo, no Node APIs.
packages/transport-nostr   Transport implementation: NIP-44 + NIP-59 gift wraps on public Nostr relays.
apps/mobile                Expo app (Android, iOS) and the shared UI. Its web export is also the desktop UI.
apps/mobile/modules/*      Local Expo modules (Android keep-alive service).
apps/mobile/plugins/*      Expo config plugins (display name, permissions, signing, entitlements).
apps/desktop               Electron shell for Windows: window, tray, autostart, notifications, secure storage.
.github/workflows          CI (tests, typecheck, web smoke test) and release builds (APK, Windows installer, IPA).
```

## Rules that hold everywhere

- Exact location never leaves the device unless the user explicitly chose a level that sends it
  (precise trip, live location, a where-reply, or an SOS they triggered). `PrivacyPolicy` in core is the gate.
- Only contacts added in person (QR + optional safety number) can reach a device. Exceptions are narrow and
  documented in `node.ts` (group members vouched for by a group owner who is a contact; own linked devices).
- Every incoming message is parsed with strict zod schemas and length limits. Rate limits protect against spam.
- Nothing is sent to any server we run (there is none). No analytics, no push tokens.
- UI text is German. Dark theme is the default.

## Platform bridge for the desktop app

The desktop shell loads the mobile app's web export from a custom `app://heyda/` protocol and exposes exactly
one object on `window`, via `contextBridge` in the preload script. The UI detects desktop mode with
`typeof window !== 'undefined' && window.heydaDesktop !== undefined`.

```ts
export interface HeydaDesktopBridge {
  readonly version: string;                       // app version, e.g. "1.0.0"
  readonly platform: 'win32' | 'darwin' | 'linux';

  // Encrypted app data. The renderer encrypts (XChaCha20-Poly1305); main only stores bytes.
  // name must match /^[a-z0-9-]{1,40}$/; data is base64 (standard alphabet); max 20 MB.
  vaultRead(name: string): Promise<string | null>;
  vaultWrite(name: string, dataB64: string): Promise<void>;   // atomic (temp file + rename)
  vaultDelete(name: string): Promise<void>;

  // Small secrets (keys), protected by the OS (Electron safeStorage, DPAPI on Windows).
  // name must match /^[a-z0-9.-]{1,60}$/; value max 4096 chars.
  secretGet(name: string): Promise<string | null>;
  secretSet(name: string, value: string): Promise<void>;
  secretDelete(name: string): Promise<void>;

  // Native notifications. level 'alarm' = SOS/overdue (sound, tries to break through Focus/DND,
  // flashes the window); 'normal' = sound; 'silent' = no sound.
  notify(n: { id: string; title: string; body: string; level: 'alarm' | 'normal' | 'silent' }): Promise<void>;
  onNotificationClick(cb: (id: string) => void): () => void;
  attention(): Promise<void>;                     // show + focus + flash the window
  setBadge(count: number): Promise<void>;         // unread count (taskbar overlay / tray tooltip)

  getAutostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;       // start hidden in the tray at login

  // Backup files. saveFile shows a save dialog; openFile an open dialog (max 5 MB). base64 data.
  saveFile(suggestedName: string, dataB64: string): Promise<boolean>;
  openFile(): Promise<{ name: string; dataB64: string } | null>;

  // Opens https:, tel:, sms: or geo: URLs in the system handler. Everything else is refused.
  openExternal(url: string): Promise<void>;
}
```

## Android keep-alive module

`apps/mobile/modules/heyda-background` is a local Expo module. It runs a foreground service of type
`remoteMessaging` that keeps a React Native headless JS task alive, so the relay connection (and with it
messages, SOS alerts and watch alarms) keeps working while the app is in the background.

```ts
// apps/mobile/src/lib/keepalive.ts (wrapper around the native module; no-ops on iOS/web)
export const keepAliveSupported: boolean;
export function registerKeepAliveTask(run: () => Promise<void>): void; // call at bundle load
export function startKeepAlive(text: { title: string; body: string }): Promise<void>;
export function stopKeepAlive(): Promise<void>;
export function isKeepAliveRunning(): Promise<boolean>;
export function setKeepAliveOnBoot(enabled: boolean): Promise<void>; // restart after reboot
export function isIgnoringBatteryOptimizations(): Promise<boolean>;
export function openBatteryOptimizationSettings(): Promise<void>;
```

The headless task name is `HeydaKeepAlive`. Its JS function resolves only when `stopKeepAlive()` is called.

## Map

`apps/mobile/src/components/TileMap.tsx` draws OpenStreetMap raster tiles with plain `Image` components, so the same
code runs on Android, iOS and the desktop/web build. It is only mounted after the user enabled the map, because the
tile server sees which area is viewed.

```tsx
export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  label: string;
  kind: 'me' | 'friend' | 'sos' | 'place' | 'destination';
  accuracyM?: number; // draws a circle
  cellM?: number;     // draws a square for coarse (grid) locations
}
export function TileMap(props: {
  markers: MapMarker[];
  height?: number;                              // default 280
  center?: { lat: number; lon: number };        // default: fit markers
  zoom?: number;                                // default: fit markers, max 16
  onPress?: (p: { lat: number; lon: number }) => void; // pick a destination
  tileUrl?: string;                             // default https://tile.openstreetmap.org/{z}/{x}/{y}.png
}): JSX.Element;
```
