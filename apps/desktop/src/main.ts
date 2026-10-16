// Electron main process: window, tray, protocol, IPC bridge, notifications, autostart.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from 'electron';
import type {
  IpcMainInvokeEvent,
  MenuItemConstructorOptions,
  NativeImage,
  NotificationConstructorOptions,
  WebContents,
} from 'electron';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { redDotPng } from './badge';
import { INVOKE_CHANNELS, NOTIFICATION_CLICK_CHANNEL, VERSION_ARG_PREFIX } from './contract';
import type { DesktopNotification, InvokeChannel } from './contract';
import {
  APP_SCHEME,
  APP_START_URL,
  InvalidArgumentError,
  MAX_OPEN_FILE_BYTES,
  MAX_SAVE_FILE_BYTES,
  MAX_VAULT_BYTES,
  expectArgCount,
  isAppUrl,
  isPermissionAllowed,
  parseBadgeCount,
  parseBase64,
  parseBoolean,
  parseExternalUrl,
  parseNotification,
  parseSecretName,
  parseSecretValue,
  parseSuggestedFileName,
  parseVaultName,
  urgentToastXml,
} from './security';
import { FileStore, SecretStore, writeFileAtomic } from './storage';
import type { SecretCipher } from './storage';
import { createWebHandler } from './web-handler';
import { CrashReloadPolicy, wantsSystemNotification } from './window-policy';
import type { WindowState } from './window-policy';

const APP_USER_MODEL_ID = 'io.github.exelerx.heyda';
const WINDOW_TITLE = 'Heyda.';
const BACKGROUND_COLOR = '#0F1115';
const HIDDEN_ARG = '--hidden';
const IS_WINDOWS = process.platform === 'win32';
const RETAINED_NOTIFICATIONS = 50;

const webRoot = path.join(__dirname, '..', 'web');
const assetsDir = path.join(__dirname, '..', 'assets');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let badgeCount = 0;
let dialogOpen = false;
// Electron only delivers 'click' while the Notification object is alive, so keep recent ones.
const liveNotifications: Notification[] = [];
const crashReloads = new CrashReloadPolicy();
const CRASH_RELOAD_DELAY_MS = 1000;

/** A failure whose message is safe and useful to show in the UI (no paths, no internals). */
class BridgeError extends Error {}

main();

function main(): void {
  applyUserDataOverride();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  if (IS_WINDOWS) app.setAppUserModelId(APP_USER_MODEL_ID);

  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
  keepRunningInBackground();

  app.on('second-instance', (_event, argv) => {
    if (app.isReady() && !argv.includes(HIDDEN_ARG)) showWindow();
  });
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (app.isReady()) showWindow();
  });

  app.whenReady().then(onReady).catch(fatal);
}

/**
 * The app lives in the tray: relay sockets, reconnect timers and watch alarms must not be throttled
 * while the window is hidden or covered. backgroundThrottling: false covers the page; these cover the rest.
 */
function keepRunningInBackground(): void {
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

/** `--user-data-dir=<dir>` gives smoke tests and side-by-side dev runs their own profile and instance lock. */
function applyUserDataOverride(): void {
  const dir = app.commandLine.getSwitchValue('user-data-dir');
  if (dir !== '') app.setPath('userData', path.resolve(dir));
}

async function onReady(): Promise<void> {
  Menu.setApplicationMenu(null);
  hardenSession();
  protocol.handle(APP_SCHEME, createWebHandler(webRoot));
  await registerBridge();
  createTray();
  createWindow(!process.argv.includes(HIDDEN_ARG));
}

function fatal(error: unknown): void {
  console.error(error);
  dialog.showErrorBox(WINDOW_TITLE, `Heyda. konnte nicht starten.\n\n${String(error)}`);
  app.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Security

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin),
  );
  ses.setDevicePermissionHandler(() => false);
}

function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
    openExternalIfAllowed(event.url);
  });
  contents.on('will-redirect', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function openExternalIfAllowed(url: string): void {
  let allowed: string;
  try {
    allowed = parseExternalUrl(url);
  } catch {
    console.warn('Blocked navigation to', url.slice(0, 200));
    return;
  }
  shell.openExternal(allowed).catch((error: unknown) => console.warn('openExternal failed', error));
}

/** Only the app's own main frame in our window may call the bridge. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame.parent === null &&
    isAppUrl(frame.url)
  );
}

// ---------------------------------------------------------------------------------------------
// Window

function createWindow(show: boolean): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    title: WINDOW_TITLE,
    width: 420,
    height: Math.max(600, Math.min(860, workArea.height - 40)),
    minWidth: 360,
    minHeight: 600,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      // Relay sockets, timers and watch alarms must keep running while the window is hidden.
      backgroundThrottling: false,
      additionalArguments: [`${VERSION_ARG_PREFIX}${app.getVersion()}`],
    },
  });

  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    void showTrayHintOnce();
  });
  // Never block a Windows shutdown or log-off with the hide-to-tray behaviour.
  win.on('query-session-end', () => {
    quitting = true;
  });
  win.on('session-end', () => {
    quitting = true;
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('show', () => applyBadge());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.once('ready-to-show', () => {
    if (show) win.show();
  });

  win.webContents.on('render-process-gone', (_event, details) => onUiGone(win, details.reason, details.exitCode));

  if (!app.isPackaged) enableDevToolsShortcut(win);
  addEditContextMenu(win.webContents);
  win.loadURL(APP_START_URL).catch((error: unknown) => console.error('Failed to load the UI', error));
  mainWindow = win;
  return win;
}

function showWindow(): BrowserWindow {
  const win = mainWindow ?? createWindow(true);
  if (win.webContents.isCrashed()) {
    // The user asks for the app again after it gave up reloading a crashing UI: try once more.
    crashReloads.reset();
    reloadUi(win);
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

/**
 * The UI process holds the relay connection and the alarm timers. If it dies while the window sits hidden in
 * the tray, nothing arrives any more, so reload it; after repeated crashes tell the user instead of looping.
 */
function onUiGone(win: BrowserWindow, reason: string, exitCode: number): void {
  if (quitting || win.isDestroyed() || reason === 'clean-exit') return;
  console.error(`The UI process ended unexpectedly (${reason}, exit code ${exitCode})`);
  if (crashReloads.shouldReload(Date.now())) {
    setTimeout(() => reloadUi(win), CRASH_RELOAD_DELAY_MS);
    return;
  }
  if (!Notification.isSupported()) return;
  showNotification(
    new Notification({
      title: 'Heyda. wurde angehalten',
      body: 'Die App ist mehrmals abgestürzt. Nachrichten und Alarme kommen erst wieder an, wenn du Heyda. öffnest.',
      urgency: 'critical',
    }),
    () => showWindow(),
  );
}

/** Loads the start page, not the current URL: some routes (e.g. group chats, "g:…") are not valid file paths. */
function reloadUi(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.loadURL(APP_START_URL).catch((error: unknown) => console.error('Failed to reload the UI', error));
}

function attention(): void {
  const win = showWindow();
  // Windows may refuse to steal focus; flashing then lasts until the 'focus' handler stops it.
  if (!win.isFocused()) win.flashFrame(true);
}

function enableDevToolsShortcut(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

/** Without an application menu there is no default context menu; pasting invite codes needs one. */
function addEditContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'cut', label: 'Ausschneiden', enabled: params.editFlags.canCut },
          { role: 'copy', label: 'Kopieren', enabled: params.editFlags.canCopy },
          { role: 'paste', label: 'Einfügen', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', label: 'Alles auswählen' },
        ]
      : params.selectionText.trim() !== ''
        ? [{ role: 'copy', label: 'Kopieren' }]
        : [];
    if (items.length > 0) Menu.buildFromTemplate(items).popup();
  });
}

// ---------------------------------------------------------------------------------------------
// Tray, badge, autostart

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip(trayTooltip());
  tray.on('click', () => showWindow());
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  if (tray === null) return;
  const template: MenuItemConstructorOptions[] = [{ label: 'Heyda. öffnen', click: () => showWindow() }];
  if (autostartSupported()) {
    template.push({
      label: 'Beim Windows-Start öffnen',
      type: 'checkbox',
      checked: getAutostart(),
      click: (item) => setAutostart(item.checked),
    });
  }
  template.push({ type: 'separator' }, { label: 'Beenden', click: () => quitApp() });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function quitApp(): void {
  quitting = true;
  app.quit();
}

function trayTooltip(): string {
  if (badgeCount === 0) return WINDOW_TITLE;
  return `${WINDOW_TITLE} – ${badgeCount > 99 ? '99+' : badgeCount} ungelesen`;
}

function setBadge(count: number): void {
  badgeCount = count;
  tray?.setToolTip(trayTooltip());
  applyBadge();
}

function applyBadge(): void {
  if (IS_WINDOWS) {
    // The overlay belongs to the taskbar button, which disappears while hidden; 'show' re-applies it.
    mainWindow?.setOverlayIcon(badgeCount > 0 ? badgeIcon() : null, badgeCount > 0 ? `${badgeCount} ungelesen` : '');
  } else {
    app.setBadgeCount(badgeCount);
  }
}

function autostartSupported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function loginItemArgs(): string[] {
  // An unpackaged run is "electron.exe <app dir>"; the login item must include the app dir.
  return app.isPackaged ? [HIDDEN_ARG] : [`"${app.getAppPath()}"`, HIDDEN_ARG];
}

function getAutostart(): boolean {
  if (!autostartSupported()) return false;
  return app.getLoginItemSettings({ args: loginItemArgs() }).openAtLogin;
}

function setAutostart(on: boolean): void {
  if (!autostartSupported()) {
    console.warn('Autostart is not supported on', process.platform);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: loginItemArgs() });
  refreshTrayMenu();
}

// ---------------------------------------------------------------------------------------------
// Notifications

function notify(n: DesktopNotification): void {
  if (!Notification.isSupported()) return;
  // The UI already shows its own banner while it is on screen (alarms excepted, see wantsSystemNotification).
  if (!wantsSystemNotification(n.level, mainWindowState())) return;
  const onClick = (): void => {
    showWindow();
    mainWindow?.webContents.send(NOTIFICATION_CLICK_CHANNEL, n.id);
  };
  if (n.level === 'alarm') {
    showAlarmNotification(n, onClick);
    attention();
  } else {
    showNotification(new Notification(plainNotificationOptions(n)), onClick);
  }
}

function mainWindowState(): WindowState | null {
  const win = mainWindow;
  if (win === null || win.isDestroyed()) return null;
  return { visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() };
}

function plainNotificationOptions(n: DesktopNotification): NotificationConstructorOptions {
  const alarm = n.level === 'alarm';
  return {
    title: n.title,
    body: n.body,
    silent: n.level === 'silent',
    urgency: alarm ? 'critical' : 'normal',
    timeoutType: alarm ? 'never' : 'default',
  };
}

/**
 * Best effort: on Windows an urgent toast (looping alarm sound, may break through Focus Assist).
 * Whether it is honoured depends on the Windows build and the user's notification settings.
 * Any error falls back to a plain notification, so an alarm is never lost to a bad toast.
 */
function showAlarmNotification(n: DesktopNotification, onClick: () => void): void {
  if (IS_WINDOWS) {
    try {
      const toast = new Notification({ toastXml: urgentToastXml(n.title, n.body) });
      toast.once('failed', (_event, error) => {
        console.warn('Urgent toast failed, falling back', error);
        showNotification(new Notification(plainNotificationOptions(n)), onClick);
      });
      showNotification(toast, onClick);
      return;
    } catch (error) {
      console.warn('Urgent toast failed, falling back', error);
    }
  }
  showNotification(new Notification(plainNotificationOptions(n)), onClick);
}

function showNotification(notification: Notification, onClick: () => void): void {
  notification.on('click', onClick);
  liveNotifications.push(notification);
  if (liveNotifications.length > RETAINED_NOTIFICATIONS) liveNotifications.shift();
  notification.show();
}

async function showTrayHintOnce(): Promise<void> {
  const stateFile = path.join(app.getPath('userData'), 'desktop-state.json');
  try {
    const state = await readJson(stateFile);
    if (state.trayHintShown === true) return;
    await writeFileAtomic(stateFile, Buffer.from(JSON.stringify({ ...state, trayHintShown: true })));
  } catch (error) {
    console.warn('Could not persist the tray hint state', error);
  }
  if (!Notification.isSupported()) return;
  showNotification(
    new Notification({
      title: 'Heyda. läuft im Infobereich weiter',
      body: 'Nachrichten und Alarme kommen weiter an. Beenden über das Symbol im Infobereich.',
      silent: true,
    }),
    () => showWindow(),
  );
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// Bridge (IPC)

async function registerBridge(): Promise<void> {
  const userData = app.getPath('userData');
  const vault = new FileStore(path.join(userData, 'vault'));
  const secretFiles = new FileStore(path.join(userData, 'secrets'));
  const secrets = new SecretStore(secretFiles, osCipher);
  await Promise.all([vault.removeStaleTempFiles(), secretFiles.removeStaleTempFiles()]);

  handle(INVOKE_CHANNELS.vaultRead, 1, async ([name]) => {
    const data = await vault.read(parseVaultName(name));
    return data === null ? null : data.toString('base64');
  });
  handle(INVOKE_CHANNELS.vaultWrite, 2, async ([name, dataB64]) => {
    await vault.write(parseVaultName(name), parseBase64(dataB64, MAX_VAULT_BYTES));
  });
  handle(INVOKE_CHANNELS.vaultDelete, 1, async ([name]) => {
    await vault.delete(parseVaultName(name));
  });

  handle(INVOKE_CHANNELS.secretGet, 1, ([name]) => secrets.get(parseSecretName(name)));
  handle(INVOKE_CHANNELS.secretSet, 2, async ([name, value]) => {
    await secrets.set(parseSecretName(name), parseSecretValue(value));
  });
  handle(INVOKE_CHANNELS.secretDelete, 1, async ([name]) => {
    await secrets.delete(parseSecretName(name));
  });

  handle(INVOKE_CHANNELS.notify, 1, ([n]) => notify(parseNotification(n)));
  handle(INVOKE_CHANNELS.attention, 0, () => attention());
  handle(INVOKE_CHANNELS.setBadge, 1, ([count]) => setBadge(parseBadgeCount(count)));

  handle(INVOKE_CHANNELS.getAutostart, 0, () => getAutostart());
  handle(INVOKE_CHANNELS.setAutostart, 1, ([on]) => setAutostart(parseBoolean(on)));

  handle(INVOKE_CHANNELS.saveFile, 2, ([name, dataB64]) =>
    saveFile(parseSuggestedFileName(name), parseBase64(dataB64, MAX_SAVE_FILE_BYTES)),
  );
  handle(INVOKE_CHANNELS.openFile, 0, () => openFile());

  handle(INVOKE_CHANNELS.openExternal, 1, async ([url]) => {
    await shell.openExternal(parseExternalUrl(url));
  });
}

function handle(channel: InvokeChannel, argCount: number, handler: (args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error('Heyda.: untrusted sender');
    try {
      expectArgCount(args, argCount);
      return await handler(args);
    } catch (error) {
      if (error instanceof InvalidArgumentError || error instanceof BridgeError) throw error;
      // Node errors carry file paths (with the Windows user name); keep those out of the renderer.
      console.error(`${channel} failed`, error);
      throw new Error(`${channel} failed`);
    }
  });
}

/** safeStorage uses DPAPI on Windows and the Keychain on macOS. Never fall back to plaintext there. */
function osCipher(): SecretCipher {
  if (!safeStorage.isEncryptionAvailable()) {
    if (process.platform !== 'linux') throw new BridgeError('Sichere Speicherung ist auf diesem System nicht verfügbar.');
    console.warn('safeStorage is unavailable: secrets are only obfuscated with a fixed key on this Linux system.');
    safeStorage.setUsePlainTextEncryption(true);
  } else if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    console.warn('No OS keyring found: secrets are only obfuscated with a fixed key on this Linux system.');
  }
  return {
    encrypt: (plainText) => safeStorage.encryptString(plainText),
    decrypt: (encrypted) => {
      try {
        return safeStorage.decryptString(encrypted);
      } catch {
        throw new BridgeError('Ein gespeicherter Schlüssel konnte nicht entschlüsselt werden.');
      }
    },
  };
}

async function saveFile(fileName: string, data: Buffer): Promise<boolean> {
  const result = await withDialog((win) =>
    dialog.showSaveDialog(win, {
      title: 'Datei speichern',
      defaultPath: path.join(app.getPath('documents'), fileName),
      filters: fileFilters(fileName),
    }),
  );
  if (result.canceled || result.filePath === undefined || result.filePath === '') return false;
  await fs.writeFile(result.filePath, data);
  return true;
}

async function openFile(): Promise<{ name: string; dataB64: string } | null> {
  const result = await withDialog((win) =>
    dialog.showOpenDialog(win, { title: 'Datei öffnen', properties: ['openFile'] }),
  );
  const file = result.canceled ? undefined : result.filePaths[0];
  if (file === undefined) return null;
  const tooLarge = new BridgeError('Die Datei ist größer als 5 MB.');
  if ((await fs.stat(file)).size > MAX_OPEN_FILE_BYTES) throw tooLarge;
  const data = await fs.readFile(file);
  if (data.length > MAX_OPEN_FILE_BYTES) throw tooLarge;
  return { name: path.basename(file), dataB64: data.toString('base64') };
}

/** One dialog at a time, attached to the (shown) main window. */
async function withDialog<T>(open: (win: BrowserWindow) => Promise<T>): Promise<T> {
  if (dialogOpen) throw new BridgeError('Es ist bereits ein Dateidialog geöffnet.');
  dialogOpen = true;
  try {
    return await open(showWindow());
  } finally {
    dialogOpen = false;
  }
}

function fileFilters(fileName: string): Electron.FileFilter[] {
  const extension = path.extname(fileName).slice(1);
  if (extension === '') return [];
  return [
    { name: `${extension.toUpperCase()}-Datei`, extensions: [extension] },
    { name: 'Alle Dateien', extensions: ['*'] },
  ];
}

// ---------------------------------------------------------------------------------------------
// Images

let cachedAppIcon: NativeImage | undefined;
let cachedBadgeIcon: NativeImage | undefined;

function appIcon(): NativeImage {
  if (cachedAppIcon === undefined) {
    try {
      // Read through fs (asar-aware) instead of createFromPath, so the icon also loads from app.asar.
      cachedAppIcon = nativeImage.createFromBuffer(readFileSync(path.join(assetsDir, 'icon.png')));
    } catch (error) {
      console.warn('App icon missing; run "npm run prepare-web -w desktop"', error);
      cachedAppIcon = nativeImage.createEmpty();
    }
  }
  return cachedAppIcon;
}

function trayIcon(): NativeImage {
  const source = appIcon();
  if (source.isEmpty()) return source;
  const icon = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = 16 * scaleFactor;
    icon.addRepresentation({ scaleFactor, buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG() });
  }
  return icon;
}

function badgeIcon(): NativeImage {
  // 32 px declared as 2x: a crisp 16 px overlay at 100 % and 200 % display scaling.
  cachedBadgeIcon ??= nativeImage.createFromBuffer(redDotPng(32), { scaleFactor: 2 });
  return cachedBadgeIcon;
}
