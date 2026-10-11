# Heyda. desktop (Windows)

Electron shell around the shared UI: the Expo web export of `apps/mobile` is served from `app://heyda/`
and talks to the OS through one object, `window.heydaDesktop` (contract in `docs/ARCHITECTURE.md`).

## Build

From the repository root, after `npm ci`:

```bash
npm run export:web -w mobile        # Expo web export -> apps/mobile/dist
npm run prepare-web -w desktop      # copy it to apps/desktop/web, icon to apps/desktop/assets
npm run build -w desktop            # tsc -> apps/desktop/build (CommonJS)
npm run dist:win -w desktop         # NSIS installer -> apps/desktop/dist/Heyda-Setup-<version>.exe (on Windows)
```

`npm run dist:dir -w desktop` builds only the unpacked app (`dist/win-unpacked/Heyda.exe` on Windows).
To run the unpacked build during development: `npx electron apps/desktop` (F12 opens DevTools when not packaged).

Checks: `npm run typecheck -w desktop`, `npm test -w desktop` (vitest, pure modules only).

## Smoke test

```bash
npm run smoke -w desktop -- --app build/main.js                 # unpacked, via Playwright's _electron
npm run smoke -w desktop -- --exe dist/win-unpacked/Heyda.exe   # packaged, via CDP
```

It starts the app with a throwaway `--user-data-dir`, checks the window title, that `window.heydaDesktop` has exactly
the contract methods (and that vault, secrets, argument validation and the URL allowlist work end to end), that no
Node globals leak into the page and that the UI renders. Console errors, page errors and CSP violations fail the run.
A screenshot goes to `--out` (default `smoke.png`). Packaged builds have the `nodeCliInspect` fuse disabled, which
`_electron.launch` needs, so `--exe` uses `--remote-debugging-port` and `chromium.connectOverCDP` instead.

## Layout

| File                  | Purpose                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `src/main.ts`         | App lifecycle, window, tray, notifications, autostart, IPC handlers            |
| `src/preload.ts`      | Sandboxed preload; exposes the bridge with `contextBridge`                     |
| `src/contract.ts`     | Bridge interface and IPC channel names (preload imports types only)           |
| `src/security.ts`     | CSP, URL/origin checks, path resolution, MIME types, IPC argument validators   |
| `src/web-handler.ts`  | `app://heyda/` handler: static files, SPA fallback, security headers           |
| `src/storage.ts`      | Vault files and safeStorage-encrypted secrets (atomic writes)                  |
| `src/badge.ts`        | Red-dot PNG for the taskbar overlay, generated in code                         |
| `scripts/`            | `prepare-web.mjs`, `smoke.mjs`                                                  |

## How the bridge works

The preload wraps `ipcRenderer.invoke` in one function per contract method and exposes only that object; the
renderer never sees `ipcRenderer`. Every channel is registered with `ipcMain.handle`, which first checks that the
call comes from the main frame of our window on `app://heyda`, then checks the argument count and validates each
argument (types, name patterns, size limits from the contract). Node errors are logged in main and replaced by a
generic message so file paths never reach the renderer.

Data lives in `%APPDATA%\Heyda` (`app.getPath('userData')`):

- `vault/h-<name>.bin`: bytes the renderer already encrypted. Writes go to a temp file, are fsynced and renamed.
  Operations on one name run in call order. Max 20 MB.
- `secrets/h-<name>.bin`: values encrypted with `safeStorage` (DPAPI on Windows). If OS encryption is unavailable the
  call fails on Windows and macOS; on Linux it falls back to Chromium's fixed-key obfuscation with a warning.
- `desktop-state.json`: whether the "runs in the tray" hint was shown.

The `h-` prefix keeps names like `con` or `nul` (allowed by the contract's patterns) clear of Windows device names.

Notifications use Electron's `Notification` in main; clicks show the window and are forwarded to
`onNotificationClick`. Level `alarm` additionally focuses and flashes the window and, on Windows, tries an urgent
toast (`scenario="urgent"`, looping alarm sound) with a plain notification as fallback. Toasts need the Start menu
shortcut the installer creates (it carries the AppUserModelID `io.github.exelerx.heyda`); unpackaged dev runs may
not show them.

Closing the window hides it to the tray; only the tray's "Beenden" quits. Autostart registers a login item that
starts the app with `--hidden`.

## Security notes

- `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity` on, no `webview`, DevTools off when packaged,
  no application menu, single-instance lock.
- Content-Security-Policy (header on every `app://` response, defined in `src/security.ts`):
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:;
  font-src 'self' data:; connect-src 'self' wss:; ...`. No `unsafe-eval`: zod v4 probes for `new Function` and falls
  back to its interpreter when blocked (`z.config({ jitless: true })` in the UI avoids the probe).
- Permissions: only `notifications` for `app://heyda`; everything else (camera, geolocation, clipboard read, HID, ...)
  is denied. Navigation away from `app://heyda` and new windows are blocked; `https:`, `tel:`, `sms:` and `geo:` links
  open in the system handler after validation, anything else is refused.
- The `app://` handler rejects encoded slashes and backslashes, dot segments, NUL and Windows-reserved characters,
  and verifies the resolved path stays inside `web/`.
- Electron fuses (set by electron-builder): no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, app only
  from `app.asar` with embedded integrity validation, encrypted cookies, no extra `file://` privileges.
- Background work: `backgroundThrottling: false` plus Chromium switches that disable timer throttling and
  backgrounding, so relay sockets and alarms keep running while the window is hidden.

Known limits: camera QR scanning does not work on desktop (camera permission denied; the web scanner would also
load its wasm from a CDN). Pair by showing the desktop's code to the phone. The installer is unsigned unless signing
is configured in CI, so SmartScreen will warn.
