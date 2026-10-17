#!/usr/bin/env node
// Smoke test for the desktop app. Launches either the unpacked build or a packaged executable,
// checks the window, the bridge and the rendered UI, fails on console/page errors and saves a screenshot.
//
//   node scripts/smoke.mjs --app build/main.js            (unpacked; needs the electron binary)
//   node scripts/smoke.mjs --exe dist/win-unpacked/Heyda.exe
//   options: --out smoke.png  --timeout 120000
//
// A packaged build has the nodeCliInspect fuse disabled, which Playwright's _electron.launch needs,
// so --exe starts the app with --remote-debugging-port and attaches over CDP instead.
import { _electron as electron, chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8')).version;
const EXPECTED_TITLE = 'Heyda.';
const BRIDGE_METHODS = [
  'vaultRead', 'vaultWrite', 'vaultDelete',
  'secretGet', 'secretSet', 'secretDelete',
  'notify', 'onNotificationClick', 'attention', 'setBadge',
  'onSaveRequest',
  'getAutostart', 'setAutostart',
  'saveFile', 'openFile', 'openExternal',
];
// zod v4 probes for eval support with `new Function('')` inside try/catch. The CSP blocks it and zod
// uses its interpreter instead. Silence it at the source with `z.config({ jitless: true })` in the UI.
const ZOD_EVAL_PROBE = /Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script/;
// Console errors that are expected and harmless. Keep this list short and justify every entry.
const BENIGN_CONSOLE_ERRORS = [
  ZOD_EVAL_PROBE,
  // Public relays can be unreachable from CI; that is the network, not the app.
  /WebSocket connection to 'wss:\/\/[^']+' failed/,
  /WebSocket is closed before the connection is established/,
];
const SETTLE_MS = 3000;

const { values: options } = parseArgs({
  options: {
    app: { type: 'string' },
    exe: { type: 'string' },
    out: { type: 'string', default: 'smoke.png' },
    timeout: { type: 'string', default: '120000' },
  },
});
const timeoutMs = Number(options.timeout);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) usage('--timeout must be a positive number of milliseconds');
if (options.app !== undefined && options.exe !== undefined) usage('pass either --app or --exe, not both');
const target = options.exe !== undefined
  ? { kind: 'exe', path: path.resolve(options.exe) }
  : { kind: 'app', path: path.resolve(options.app ?? path.join(desktopDir, 'build', 'main.js')) };
if (!existsSync(target.path)) usage(`${target.path} does not exist (did you run "npm run build"?)`);
const screenshotPath = path.resolve(options.out);

const problems = [];
const notes = [];
let session;
let userDataDir;

const deadline = setTimeout(() => {
  console.error(`smoke: FAILED, timed out after ${timeoutMs} ms`);
  void cleanup().finally(() => process.exit(1));
}, timeoutMs);

try {
  await run();
} catch (error) {
  problems.push(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  await cleanup();
  clearTimeout(deadline);
}
report();
process.exit(process.exitCode ?? 0);

async function run() {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'heyda-smoke-'));
  session = target.kind === 'exe' ? await launchExecutable(target.path) : await launchUnpacked(target.path);

  const page = await firstAppPage(session.context);
  watchPage(page);
  await installCspProbe(page);
  // Listeners attach after the first load may have started; a reload makes sure every message is seen.
  await page.reload({ waitUntil: 'load', timeout: timeoutMs });
  if (!page.url().startsWith('app://heyda/')) problems.push(`unexpected URL ${page.url()}`);

  await checkTitle(page);
  await checkIsolation(page);
  await checkBridge(page);
  await waitForRenderedUi(page);
  await page.waitForTimeout(SETTLE_MS);
  await checkCspViolations(page);
  await page.screenshot({ path: screenshotPath });
  notes.push(`screenshot: ${screenshotPath}`);
}

// ---------------------------------------------------------------------------------------------
// Launching

async function launchUnpacked(mainPath) {
  const appDir = appDirFor(mainPath);
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    timeout: timeoutMs,
  });
  app.on('console', (message) => {
    if (message.type() === 'error') problems.push(`main process console error: ${message.text()}`);
  });
  return {
    context: app.context(),
    nativeTitles: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle())),
    // The app hides to the tray on close; app.quit() (what Playwright calls) really quits.
    close: () => app.close(),
  };
}

/**
 * Electron only reads name and version from package.json when it is started with the app directory,
 * so `--app build/main.js` is mapped to the directory whose package.json points at that file.
 */
function appDirFor(mainPath) {
  if (statSync(mainPath).isDirectory()) return mainPath;
  for (let dir = path.dirname(mainPath), i = 0; i < 3; dir = path.dirname(dir), i++) {
    const manifest = path.join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const main = JSON.parse(readFileSync(manifest, 'utf8')).main;
    if (typeof main === 'string' && path.resolve(dir, main) === mainPath) return dir;
  }
  notes.push('no package.json points at the given main file; app name and version come from Electron');
  return mainPath;
}

async function launchExecutable(exePath) {
  const child = spawn(exePath, ['--remote-debugging-port=0', `--user-data-dir=${userDataDir}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  const endpoint = await new Promise((resolve, reject) => {
    let buffered = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        stderr.push(line);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
        if (match) resolve(match[1]);
      }
    });
    child.stdout.resume();
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`app exited early with code ${code}\n${stderr.slice(-20).join('\n')}`)));
  });
  const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('no browser context over CDP');
  return {
    context,
    nativeTitles: null,
    close: async () => {
      await browser.close().catch(() => undefined);
      await killTree(child);
    },
  };
}

async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

async function firstAppPage(context) {
  // Polling covers both cases: the window already exists, or it has not committed its URL yet.
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const page = context.pages().find((p) => p.url().startsWith('app://heyda/'));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('no app://heyda/ window appeared');
}

// ---------------------------------------------------------------------------------------------
// Checks

function watchPage(page) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BENIGN_CONSOLE_ERRORS.some((pattern) => pattern.test(text))) notes.push(`ignored known console error: ${text}`);
    else problems.push(`console error: ${text}`);
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.stack ?? error.message}`));
  page.on('crash', () => problems.push('renderer crashed'));
}

// Chromium reports CSP violations as DOM events, not through the console API Playwright listens to.
async function installCspProbe(page) {
  await page.addInitScript(() => {
    const violations = [];
    Object.defineProperty(window, '__heydaSmokeCsp', { value: violations });
    document.addEventListener('securitypolicyviolation', (e) => {
      violations.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile });
    });
  });
}

async function checkCspViolations(page) {
  const violations = await page.evaluate(() => window.__heydaSmokeCsp ?? null);
  if (violations === null) {
    problems.push('the CSP probe was not installed');
    return;
  }
  for (const v of violations) {
    const text = `CSP blocked ${v.blocked || '(inline)'} (${v.directive}) in ${v.source || 'unknown source'}`;
    if (v.blocked === 'eval') notes.push(`ignored known ${text}: zod's eval probe, see ZOD_EVAL_PROBE`);
    else problems.push(text);
  }
}

async function checkTitle(page) {
  if (session.nativeTitles) {
    const titles = await session.nativeTitles();
    if (!titles.includes(EXPECTED_TITLE)) problems.push(`window title is ${JSON.stringify(titles)}, expected "${EXPECTED_TITLE}"`);
  } else {
    // Over CDP only the document title is visible; main pins the native title to "Heyda.".
    const title = await page.title();
    if (!title.includes('Heyda')) problems.push(`document title is "${title}", expected it to contain "Heyda"`);
  }
}

async function checkIsolation(page) {
  // The Metro bundle defines a stub `process` global itself, so look for real Node/Electron capabilities.
  const leaks = await page.evaluate(() => {
    const g = globalThis;
    const found = [];
    if (typeof g.require === 'function') found.push('require');
    if (typeof g.module?.require === 'function') found.push('module.require');
    if (typeof g.process?.versions?.node === 'string') found.push('process.versions.node');
    if (typeof g.process?.versions?.electron === 'string') found.push('process.versions.electron');
    if ('ipcRenderer' in g || 'electron' in g) found.push('electron');
    return found;
  });
  if (leaks.length > 0) problems.push(`renderer can see Node/Electron globals: ${leaks.join(', ')}`);
}

async function checkBridge(page) {
  const result = await page.evaluate(async (methods) => {
    const bridge = window.heydaDesktop;
    if (bridge === undefined) return { error: 'window.heydaDesktop is missing' };
    const missing = methods.filter((m) => typeof bridge[m] !== 'function');
    const extra = Object.keys(bridge).filter((k) => !methods.includes(k) && k !== 'version' && k !== 'platform');
    const sample = btoa('heyda-smoke');
    await bridge.vaultWrite('smoke-test', sample);
    const vaultRoundTrip = (await bridge.vaultRead('smoke-test')) === sample;
    await bridge.vaultDelete('smoke-test');
    const vaultDeleted = (await bridge.vaultRead('smoke-test')) === null;
    await bridge.secretSet('smoke.test', 'geheim');
    const secretRoundTrip = (await bridge.secretGet('smoke.test')) === 'geheim';
    await bridge.secretDelete('smoke.test');
    const rejectsBadName = await bridge.vaultRead('../escape').then(() => false, () => true);
    const rejectsFileUrl = await bridge.openExternal('file:///C:/Windows/System32/calc.exe').then(() => false, () => true);
    const autostart = await bridge.getAutostart();
    return {
      missing, extra, version: bridge.version, platform: bridge.platform,
      vaultRoundTrip, vaultDeleted, secretRoundTrip, rejectsBadName, rejectsFileUrl,
      autostartIsBoolean: typeof autostart === 'boolean',
    };
  }, BRIDGE_METHODS);

  if (result.error) {
    problems.push(result.error);
    return;
  }
  if (result.missing.length > 0) problems.push(`bridge is missing: ${result.missing.join(', ')}`);
  if (result.extra.length > 0) problems.push(`bridge exposes more than the contract: ${result.extra.join(', ')}`);
  if (result.version !== packageVersion) problems.push(`bridge version ${result.version}, expected ${packageVersion}`);
  const platform = ['win32', 'darwin'].includes(process.platform) ? process.platform : 'linux';
  if (result.platform !== platform) problems.push(`bridge platform ${result.platform}, expected ${platform}`);
  for (const check of ['vaultRoundTrip', 'vaultDeleted', 'secretRoundTrip', 'rejectsBadName', 'rejectsFileUrl', 'autostartIsBoolean']) {
    if (result[check] !== true) problems.push(`bridge check failed: ${check}`);
  }
  notes.push(`bridge ok: version ${result.version}, platform ${result.platform}`);
}

async function waitForRenderedUi(page) {
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root');
        if (root === null) return false;
        const box = root.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && root.innerText.trim().length > 0;
      },
      undefined,
      { timeout: Math.min(timeoutMs, 60_000) },
    );
  } catch {
    problems.push('the React root did not render visible text');
  }
}

// ---------------------------------------------------------------------------------------------

async function cleanup() {
  const current = session;
  session = undefined;
  if (current) await current.close().catch((error) => notes.push(`close failed: ${error}`));
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}

function report() {
  for (const note of notes) console.log(`smoke: ${note}`);
  if (problems.length === 0) {
    console.log(`smoke: OK (${target.kind} ${target.path})`);
    return;
  }
  for (const problem of problems) console.error(`smoke: ${problem}`);
  console.error(`smoke: FAILED with ${problems.length} problem(s)`);
  process.exitCode = 1;
}

function usage(message) {
  console.error(`smoke: ${message}\nusage: node scripts/smoke.mjs [--app <build/main.js> | --exe <Heyda.exe>] [--out smoke.png] [--timeout ms]`);
  process.exit(2);
}
