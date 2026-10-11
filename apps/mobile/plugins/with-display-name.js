// Shows "Heyda." to users while the Expo `name` stays "Heyda".
//
// The Expo `name` ends up in Gradle project names (settings.gradle rootProject.name) and in Xcode
// target, scheme and path names, where a trailing dot is invalid or risky. So app.json uses
// "Heyda" and this plugin sets only the user-visible labels:
//   Android: strings.xml app_name (launcher label, app info, notification header)
//   iOS:     Info.plist CFBundleDisplayName (home screen, settings)
// The web title comes from app.json web.name, not from here.
//
// Usage in app.json: ["./plugins/with-display-name", { "displayName": "Heyda." }]
const { AndroidConfig, withInfoPlist, withStringsXml } = require('expo/config-plugins');

const DEFAULT_DISPLAY_NAME = 'Heyda.';

/** Escapes a value for an Android string resource (quotes, backslashes, leading @ or ?). */
function escapeAndroidString(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/^([@?])/, '\\$1');
}

function withDisplayName(config, props) {
  const displayName = (props && props.displayName) || DEFAULT_DISPLAY_NAME;
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    throw new Error('with-display-name: "displayName" must be a non-empty string.');
  }

  // Expo's built-in name plugins are registered after app.json plugins, so their mods run first
  // and these run afterwards: the values below win.
  config = withStringsXml(config, (cfg) => {
    cfg.modResults = AndroidConfig.Strings.setStringItem(
      [AndroidConfig.Resources.buildResourceItem({ name: 'app_name', value: escapeAndroidString(displayName) })],
      cfg.modResults,
    );
    return cfg;
  });

  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.CFBundleDisplayName = displayName;
    return cfg;
  });

  return config;
}

module.exports = withDisplayName;
