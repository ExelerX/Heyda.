// Android release signing and versionCode from the environment at prebuild time.
//
// Signing: if all four variables below are set when `expo prebuild` runs, android/app/build.gradle
// gets a `release` signingConfig that reads them with System.getenv() when Gradle runs (nothing
// secret is written to the file), and the release build type uses it. If none is set, the template
// default stays: release builds are signed with the debug keystore ("test key"). If only some are
// set, prebuild fails, so a misconfigured CI never silently produces a test-signed release.
//   HEYDA_ANDROID_KEYSTORE           absolute path to the .jks/.keystore file
//   HEYDA_ANDROID_KEYSTORE_PASSWORD
//   HEYDA_ANDROID_KEY_ALIAS
//   HEYDA_ANDROID_KEY_PASSWORD
// The same variables must also be set when Gradle builds the release APK.
//
// versionCode: if HEYDA_VERSION_CODE is set (integer 1..2100000000), it becomes android.versionCode.
//
// The edits are idempotent (prebuild without --clean edits the existing file again) and fail loudly
// when the template no longer has the expected blocks.
const fs = require('fs');
const path = require('path');
const { WarningAggregator, withAppBuildGradle } = require('expo/config-plugins');

const TAG = 'heyda-release-signing';
const BEGIN_MARK = `// @generated begin ${TAG} (plugins/with-release-signing.js)`;
const END_MARK = `// @generated end ${TAG}`;
const BUILD_TYPE_MARK = `// @generated ${TAG}`;

const SIGNING_ENV = [
  'HEYDA_ANDROID_KEYSTORE',
  'HEYDA_ANDROID_KEYSTORE_PASSWORD',
  'HEYDA_ANDROID_KEY_ALIAS',
  'HEYDA_ANDROID_KEY_PASSWORD',
];
const MAX_VERSION_CODE = 2100000000; // Google Play's upper limit

function fail(message) {
  throw new Error(`with-release-signing: ${message}`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** null when unset, otherwise the validated integer. */
function readVersionCode() {
  const raw = process.env.HEYDA_VERSION_CODE;
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) fail(`HEYDA_VERSION_CODE must be a positive integer, got "${raw}".`);
  const versionCode = Number(value);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
    fail(`HEYDA_VERSION_CODE must be between 1 and ${MAX_VERSION_CODE}, got ${value}.`);
  }
  return versionCode;
}

/** true when all signing variables are set, false when none is; throws when only some are. */
function signingRequested() {
  const missing = SIGNING_ENV.filter((name) => !process.env[name]);
  if (missing.length === 0) return true;
  if (missing.length === SIGNING_ENV.length) return false;
  fail(`set all of ${SIGNING_ENV.join(', ')} or none. Missing: ${missing.join(', ')}.`);
}

/** The single match of a global, multiline regex, or a loud failure naming the anchor. */
function singleMatch(source, regex, anchor) {
  const matches = [...source.matchAll(regex)];
  if (matches.length !== 1) {
    fail(
      `expected exactly one "${anchor}" in android/app/build.gradle, found ${matches.length}. ` +
        'The Expo template has changed; update plugins/with-release-signing.js.',
    );
  }
  return matches[0];
}

/** Index of the `}` closing the `{` at openIndex. Skips comments and quoted strings. */
function findClosingBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', i);
      if (lineEnd === -1) return -1;
      i = lineEnd;
    } else if (c === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', i + 2);
      if (commentEnd === -1) return -1;
      i = commentEnd + 1;
    } else if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < source.length && !source.startsWith(quote, j)) j += source[j] === '\\' ? 2 : 1;
      if (j >= source.length) return -1;
      i = j + quote.length - 1;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function releaseSigningConfig(indent) {
  const i1 = indent;
  const i2 = `${indent}    `;
  const i3 = `${i2}    `;
  return [
    `${i1}${BEGIN_MARK}`,
    `${i1}// Read from the environment when Gradle runs; nothing secret is stored in this file.`,
    `${i1}release {`,
    `${i2}def heydaKeystore = System.getenv('HEYDA_ANDROID_KEYSTORE')`,
    `${i2}if (heydaKeystore) {`,
    `${i3}storeFile file(heydaKeystore)`,
    `${i2}}`,
    `${i2}storePassword System.getenv('HEYDA_ANDROID_KEYSTORE_PASSWORD')`,
    `${i2}keyAlias System.getenv('HEYDA_ANDROID_KEY_ALIAS')`,
    `${i2}keyPassword System.getenv('HEYDA_ANDROID_KEY_PASSWORD')`,
    `${i1}}`,
    `${i1}${END_MARK}`,
  ].join('\n');
}

/** Removes everything this plugin added, restoring the template's debug signing for release. */
function removeReleaseSigning(source) {
  let result = source;
  const begin = result.indexOf(BEGIN_MARK);
  if (begin !== -1) {
    const end = result.indexOf(END_MARK, begin);
    if (end === -1) fail(`found "${BEGIN_MARK}" without "${END_MARK}" in android/app/build.gradle.`);
    const lineStart = result.lastIndexOf('\n', begin) + 1;
    const lineEnd = result.indexOf('\n', end);
    result = result.slice(0, lineStart) + (lineEnd === -1 ? '' : result.slice(lineEnd + 1));
  }
  return result.replace(
    new RegExp(`signingConfig[ \\t]+signingConfigs\\.release[ \\t]*${escapeRegExp(BUILD_TYPE_MARK)}`, 'g'),
    'signingConfig signingConfigs.debug',
  );
}

function addReleaseSigning(source) {
  let result = removeReleaseSigning(source);

  // 1. signingConfigs { ... } gets a release { ... } entry.
  const signingConfigs = singleMatch(result, /^([ \t]*)signingConfigs[ \t]*\{/gm, 'signingConfigs {');
  const insertAt = signingConfigs.index + signingConfigs[0].length;
  result = `${result.slice(0, insertAt)}\n${releaseSigningConfig(`${signingConfigs[1]}    `)}${result.slice(insertAt)}`;

  // 2. buildTypes { release { signingConfig signingConfigs.debug } } switches to signingConfigs.release.
  const buildTypes = singleMatch(result, /^[ \t]*buildTypes[ \t]*\{/gm, 'buildTypes {');
  const buildTypesOpen = buildTypes.index + buildTypes[0].length - 1;
  const buildTypesClose = findClosingBrace(result, buildTypesOpen);
  if (buildTypesClose === -1) fail('could not find the end of the "buildTypes" block in android/app/build.gradle.');
  const releaseType = singleMatch(
    result.slice(buildTypesOpen + 1, buildTypesClose),
    /^[ \t]*release[ \t]*\{/gm,
    'buildTypes { release {',
  );
  const releaseOpen = buildTypesOpen + 1 + releaseType.index + releaseType[0].length - 1;
  const releaseClose = findClosingBrace(result, releaseOpen);
  if (releaseClose === -1) fail('could not find the end of "buildTypes { release {" in android/app/build.gradle.');
  const releaseBody = result.slice(releaseOpen, releaseClose);
  singleMatch(
    releaseBody,
    /^[ \t]*signingConfig[ \t]+signingConfigs\.debug[ \t]*$/gm,
    'signingConfig signingConfigs.debug (in buildTypes.release)',
  );
  const newReleaseBody = releaseBody.replace(
    /^([ \t]*)signingConfig[ \t]+signingConfigs\.debug[ \t]*$/m,
    `$1signingConfig signingConfigs.release ${BUILD_TYPE_MARK}`,
  );
  return result.slice(0, releaseOpen) + newReleaseBody + result.slice(releaseClose);
}

function withReleaseSigning(config) {
  const versionCode = readVersionCode();
  if (versionCode !== null) {
    // Applied to build.gradle by Expo's built-in version plugin.
    config.android = { ...(config.android || {}), versionCode };
  }

  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      fail('android/app/build.gradle is not Groovy; cannot configure release signing.');
    }
    let contents = cfg.modResults.contents;

    if (signingRequested()) {
      const keystore = process.env.HEYDA_ANDROID_KEYSTORE;
      if (!path.isAbsolute(keystore)) fail(`HEYDA_ANDROID_KEYSTORE must be an absolute path, got "${keystore}".`);
      if (!fs.existsSync(keystore)) {
        WarningAggregator.addWarningAndroid(
          'with-release-signing',
          `no keystore at ${keystore} yet; it must exist when Gradle builds the release APK.`,
        );
      }
      contents = addReleaseSigning(contents);
      console.log('[with-release-signing] Release builds will be signed with the keystore from HEYDA_ANDROID_KEYSTORE.');
    } else {
      contents = removeReleaseSigning(contents);
      console.log('[with-release-signing] HEYDA_ANDROID_* not set: release builds are signed with the debug keystore (test key).');
    }

    if (versionCode !== null && !new RegExp(`^[ \\t]*versionCode[ \\t]+${versionCode}[ \\t]*$`, 'm').test(contents)) {
      fail(`versionCode ${versionCode} (HEYDA_VERSION_CODE) was not applied to android/app/build.gradle.`);
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = withReleaseSigning;
