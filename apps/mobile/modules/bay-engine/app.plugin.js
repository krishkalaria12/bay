const { withAndroidManifest, withEntitlementsPlist, withGradleProperties, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

// Bay as the default browser (B9) needs Apple's managed `com.apple.developer.web-browser` entitlement, which Apple
// grants on request; the request isn't in our hands. Builds turned out with BAY_DEFAULT_BROWSER=1 claim it so a
// grant (or an App Store submission) can use it; without the flag, local dev builds keep signing as they do today.
const defaultBrowser = process.env.BAY_DEFAULT_BROWSER === "1";

const gradleProperties = {
  // The Rust ad blocker (libbay_adblock.so, scripts/adblock) is built for arm64 only, so other ABIs would crash on
  // the first page load, and each extra ABI adds a copy of every native library. The Apple-Silicon emulator is arm64.
  reactNativeArchitectures: "arm64-v8a",
  "android.enableShrinkResourcesInReleaseBuilds": "true",
};

// The share extension (B14) has one Swift file and one Info.plist, kept as plain committed files next to the app so
// prebuild never regenerates them; the wiring below points the target at them. The relative paths are against the
// project, which prebuild places in `ios`.
const shareExtensionSources = ["../share-extension/BayShare/BayShareController.swift"];
const shareExtensionInfoPlist = '"../share-extension/BayShare/BayShare-Info.plist"';

// A browser accepts HTTP pages. TLS validation and mixed-content restrictions still apply.
module.exports = function withBayEngine(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSAppTransportSecurity = {
      ...mod.modResults.NSAppTransportSecurity,
      NSAllowsArbitraryLoadsInWebContent: true,
    };
    // Saving images (B13): the photo library asks for it from the moment it's needed, as Safari's image menu does.
    mod.modResults.NSPhotoLibraryAddUsageDescription = "Bay saves images you ask for to your photo library.";
    // iOS 26 keeps a download running after Bay leaves the screen as a continued-processing task, one identifier per
    // download (BayDownloads.swift). Without this entry, registering one would crash, so BayDownloads checks for it.
    const downloadTasks = `${config.ios?.bundleIdentifier ?? "in.krishkalaria.bay.mobile"}.download.*`;
    const permitted = mod.modResults.BGTaskSchedulerPermittedIdentifiers ?? [];

    if (!permitted.includes(downloadTasks)) mod.modResults.BGTaskSchedulerPermittedIdentifiers = [...permitted, downloadTasks];

    return mod;
  });
  config = withEntitlementsPlist(config, (mod) => {
    if (defaultBrowser) mod.modResults["com.apple.developer.web-browser"] = true;

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

  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    const activity = application?.activity?.find((entry) => entry.$["android:name"] === ".MainActivity");

    if (application && activity) {
      // Sharing into Bay (B14): what other apps share as text matches here, and the engine reads the web address out
      // of it (BayEngineModule.takeShare). The B9 web scheme filter answers links other apps open directly.
      const shared = {
        action: [{ $: { "android:name": "android.intent.action.SEND" } }],
        category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
        data: [{ $: { "android:mimeType": "text/plain" } }],
      };

      if (!activity["intent-filter"]?.some((filter) => filter.action?.some((entry) => entry.$["android:name"] === "android.intent.action.SEND"))) {
        activity["intent-filter"] = [...(activity["intent-filter"] ?? []), shared];
      }

      application.$["android:usesCleartextTraffic"] = "true";
    }

    return mod;
  });

  return withXcodeProject(config, (mod) => {
    addShareExtension(mod.modResults, config.ios?.bundleIdentifier ?? "in.krishkalaria.bay.mobile");

    return mod;
  });
};

// The share extension (B14) is the only way to appear in a share sheet on iOS. Keeping its Swift file and Info.plist
// as plain files next to the app (share-extension/, which prebuild never touches) keeps the handoff logic versioned
// with the engine's; this wires the Xcode target itself. node-xcode's addTarget does most of it: the target, its
// product, the embed phase on Bay and the Sources phase for the Swift file. The rest is done by hand here, for two
// node-xcode quirks: `updateBuildProperty` matches targets by comment, where the created name is already quoted, and
// `addTargetDependency` writes nothing at all when a fresh project lacks its sections.
function addShareExtension(project, bundleId) {
  const targets = project.pbxNativeTargetSection() ?? {};

  if (Object.values(targets).some((target) => target?.productType === '"com.apple.product-type.app-extension"')) return;

  const share = project.addTarget("BayShare", "app_extension", "../share-extension/BayShare", `${bundleId}.share`);

  // So building Bay builds the extension before embedding it. A fresh Expo project has neither section yet.
  const objects = project.hash.project.objects;
  objects.PBXContainerItemProxy ??= {};
  objects.PBXTargetDependency ??= {};
  project.addTargetDependency(project.getFirstTarget().uuid, [share.uuid]);

  // The Sources phase: addTarget creates none, so the one Swift file gets one of its own.
  project.addBuildPhase(shareExtensionSources, "PBXSourcesBuildPhase", "Sources", share.uuid);

  // The extension matches Bay's own deployment target and builds like it does; its plist, source and bundle id
  // come from addTarget (an id) and the constants above.
  const minimum = unquote(project.getBuildProperty("IPHONEOS_DEPLOYMENT_TARGET"));
  const settings = {
    INFOPLIST_FILE: shareExtensionInfoPlist,
    SWIFT_VERSION: '"5.0"',
    TARGETED_DEVICE_FAMILY: '"1,2"',
    IPHONEOS_DEPLOYMENT_TARGET: `"${minimum}"`,
  };

  for (const item of project.pbxXCConfigurationList()[share.pbxNativeTarget.buildConfigurationList].buildConfigurations) {
    const config = project.pbxXCBuildConfigurationSection()[unquote(typeof item === "string" ? item : item.value)];

    if (config) Object.assign(config.buildSettings, settings);
  }
}

function unquote(value) {
  if (typeof value !== "string") return value;

  return value.replace(/^"(.*)"$/, "$1");
}
