#!/usr/bin/env node
// Copies the Expo web export (apps/mobile/dist) into apps/desktop/web and the app icon into
// apps/desktop/assets, so electron-builder can pack both into app.asar.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = path.resolve(desktopDir, '..', 'mobile');
const exportDir = path.join(mobileDir, 'dist');
const webDir = path.join(desktopDir, 'web');
const iconSource = path.join(mobileDir, 'assets', 'icon.png');
const iconTarget = path.join(desktopDir, 'assets', 'icon.png');

function fail(message) {
  console.error(`prepare-web: ${message}`);
  process.exit(1);
}

const indexFile = path.join(exportDir, 'index.html');
if (!existsSync(indexFile)) {
  fail(
    `No Expo web export found at ${exportDir}.\n` +
      'Create it first, from the repository root:\n' +
      '  npm run export:web -w mobile',
  );
}
if (!existsSync(iconSource)) fail(`App icon not found at ${iconSource}.`);

// The desktop CSP is script-src 'self': inline or remote scripts would be blocked at runtime.
const html = readFileSync(indexFile, 'utf8');
for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
  const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
  if (src === undefined) fail(`index.html contains an inline script (${tag}); the desktop CSP forbids it.`);
  if (!src.startsWith('/') || src.startsWith('//')) fail(`index.html loads a non-local script (${src}).`);
}

rmSync(webDir, { recursive: true, force: true });
cpSync(exportDir, webDir, { recursive: true });
mkdirSync(path.dirname(iconTarget), { recursive: true });
copyFileSync(iconSource, iconTarget);

console.log(`prepare-web: copied ${path.relative(desktopDir, exportDir) || exportDir} -> web/ and the app icon -> assets/`);
