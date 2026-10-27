// Heyda. only schedules local notifications and never uses Apple's push service (there is no
// server). expo-notifications still adds the Push entitlement ("aps-environment") on iOS; remove it,
// so the app asks for no capability it does not use and installs with a free Apple ID (sideloading).
// List it BEFORE "expo-notifications" in app.json: mods of later plugins run first, so this one runs last.
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withLocalNotificationsOnly(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment'];
    return cfg;
  });
};
