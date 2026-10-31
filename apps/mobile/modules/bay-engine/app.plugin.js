const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

// A browser accepts HTTP pages. TLS validation and mixed-content restrictions still apply.
module.exports = function withBayEngine(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSAppTransportSecurity = {
      ...mod.modResults.NSAppTransportSecurity,
      NSAllowsArbitraryLoadsInWebContent: true,
    };
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
};
