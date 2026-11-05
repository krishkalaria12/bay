const { withAndroidManifest, withGradleProperties, withInfoPlist } = require("expo/config-plugins");

const gradleProperties = {
  // The Rust ad blocker (libbay_adblock.so, scripts/adblock) is built for arm64 only, so other ABIs would crash on
  // the first page load, and each extra ABI adds a copy of every native library. The Apple-Silicon emulator is arm64.
  reactNativeArchitectures: "arm64-v8a",
  "android.enableShrinkResourcesInReleaseBuilds": "true",
};

// A browser accepts HTTP pages. TLS validation and mixed-content restrictions still apply.
module.exports = function withBayEngine(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSAppTransportSecurity = {
      ...mod.modResults.NSAppTransportSecurity,
      NSAllowsArbitraryLoadsInWebContent: true,
    };
    // iOS 26 keeps a download running after Bay leaves the screen as a continued-processing task, one identifier per
    // download (BayDownloads.swift). Without this entry, registering one would crash, so BayDownloads checks for it.
    const downloadTasks = `${config.ios?.bundleIdentifier ?? "in.krishkalaria.bay.mobile"}.download.*`;
    const permitted = mod.modResults.BGTaskSchedulerPermittedIdentifiers ?? [];
    if (!permitted.includes(downloadTasks)) mod.modResults.BGTaskSchedulerPermittedIdentifiers = [...permitted, downloadTasks];
    return mod;
  });
  config = withGradleProperties(config, (mod) => {
    for (const [key, value] of Object.entries(gradleProperties)) {
      const item = mod.modResults.find((item) => item.type === "property" && item.key === key);
      if (item) item.value = value;
      else mod.modResults.push({ type: "property", key, value });
    }
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
};
