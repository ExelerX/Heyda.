#!/usr/bin/env node
// Prints the app version and the matching Android versionCode as GitHub step outputs
// ("version=1.0.0", "code=10000"). Fails if the phone and Windows apps disagree on the version.
import { readFileSync } from 'node:fs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const mobile = read('apps/mobile/app.json').expo.version;
const desktop = read('apps/desktop/package.json').version;
if (mobile !== desktop) {
  console.error(`Version mismatch: apps/mobile/app.json has ${mobile}, apps/desktop/package.json has ${desktop}.`);
  process.exit(1);
}
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(mobile);
if (!m || Number(m[2]) > 99 || Number(m[3]) > 99) {
  console.error(`Version ${mobile} must look like MAJOR.MINOR.PATCH with MINOR and PATCH below 100.`);
  process.exit(1);
}
// Always increases with the version, so Android accepts every new release as an update.
const code = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
console.log(`version=${mobile}`);
console.log(`code=${code}`);
