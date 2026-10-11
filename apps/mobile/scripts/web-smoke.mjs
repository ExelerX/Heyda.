#!/usr/bin/env node
// Smoke test for the web build (the same UI the Windows app shows). Serves apps/mobile/dist,
// opens every screen in Chromium in demo mode, fails on page errors, console errors and
// unknown routes, and saves a screenshot per screen.
//   npm run export:web -w mobile && npm run smoke:web -w mobile -- --out web-smoke
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { values: opts } = parseArgs({ options: { out: { type: 'string', default: 'web-smoke' }, only: { type: 'string' } } });
const outDir = path.resolve(opts.out);
if (!existsSync(path.join(root, 'index.html'))) {
  console.error(`No web export in ${root}. Run "npm run export:web -w mobile" first.`);
  process.exit(1);
}

const LISA = 'a1'.repeat(32);
const OMA = 'c3'.repeat(32);
const ROUTES = [
  '/', '/chats', '/map', '/automations', '/me',
  '/welcome', '/pair', '/activity', '/trip', '/live', '/checkin', '/watch', '/quiet', '/status', '/safety',
  '/settings', '/devices', '/backup', '/places', '/place/new', '/plugin', '/rule/new', '/group/new', '/sos',
  `/contact/${LISA}`, `/chat/${LISA}`, `/where/${OMA}`, `/sos-alert/${LISA}`,
  '/template/core.almost-there',
  // Untrusted deep links must show a friendly state, not crash.
  '/contact/not-a-key', '/chat/g:unknown', '/group/unknown', '/place/unknown', '/rule/unknown', '/template/unknown',
];
const BAD_TEXT = /Unmatched Route|Something went wrong|This screen doesn't exist|Render Error/i;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const problems = [];
const routes = opts.only ? ROUTES.filter((r) => r.includes(opts.only)) : ROUTES;
try {
  for (const route of routes) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    page.on('dialog', (d) => void d.dismiss());
    await page.goto(base + route, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    if (BAD_TEXT.test(text)) errors.push(`shows an error screen: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    if (text.trim().length < 10) errors.push('renders (almost) nothing');
    const name = route === '/' ? 'start' : route.slice(1).replace(/[^a-z0-9-]+/gi, '_').slice(0, 60);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    for (const e of errors) problems.push(`${route}: ${e}`);
    console.log(`${errors.length ? 'FAIL' : 'ok  '} ${route}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nWeb smoke test passed (${routes.length} screens). Screenshots: ${outDir}`);
