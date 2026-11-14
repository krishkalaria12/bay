const {
  withAndroidManifest,
  withAppBuildGradle,
  withEntitlementsPlist,
  withGradleProperties,
  withInfoPlist,
  withMainApplication,
  withProjectBuildGradle,
  withXcodeProject,
} = require("expo/config-plugins");

// Bay as the default browser (B9) needs Apple's managed `com.apple.developer.web-browser` entitlement, which Apple
// grants on request; the request isn't in our hands. Builds turned out with BAY_DEFAULT_BROWSER=1 claim it so a
// grant (or an App Store submission) can use it; without the flag, local dev builds keep signing as they do today.
const defaultBrowser = process.env.BAY_DEFAULT_BROWSER === "1";

// Passkeys in pages (B20): WebKit lets a third-party browser's WKWebView use WebAuthn on any site only with the
// browser entitlement above plus Apple's managed `com.apple.developer.web-browser.public-key-credential`, granted
// on a separate request. Its own flag, BAY_WEB_PASSKEYS=1, so a build never claims it before the profile carries
// it (signing fails on an entitlement the profile lacks). Password AutoFill in pages (QuickType suggestions and
// saving to Passwords on any site) rides on the browser entitlement alone; neither needs any WKWebView setting.
const webPasskeys = defaultBrowser && process.env.BAY_WEB_PASSKEYS === "1";

const gradleProperties = {
  // Bay's engine (bay-engine.aar) is built for arm64 only, so other ABIs would have no engine, and each extra ABI adds
  // a copy of every native library. The Apple-Silicon emulator is arm64.
  reactNativeArchitectures: "arm64-v8a",
  "android.enableShrinkResourcesInReleaseBuilds": "true",
};

// The share extension (B14) and the search widget (B15) each have one Swift file and one Info.plist, kept as plain
// committed files next to the app so prebuild never regenerates them; the wiring below points the targets at them.
// The relative paths are against the project, which prebuild places in `ios`.
const shareExtensionSources = ["../share-extension/BayShare/BayShareController.swift"];
const shareExtensionInfoPlist = '"../share-extension/BayShare/BayShare-Info.plist"';
const widgetExtensionSources = ["../widget-extension/BayWidget/BayWidget.swift"];
const widgetExtensionInfoPlist = '"../widget-extension/BayWidget/BayWidget-Info.plist"';

// A browser accepts HTTP pages. TLS validation and mixed-content restrictions still apply.
module.exports = function withBayEngine(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSAppTransportSecurity = {
      ...mod.modResults.NSAppTransportSecurity,
      NSAllowsArbitraryLoadsInWebContent: true,
    };
    // Saving images (B13): the photo library asks for it from the moment it's needed, as Safari's image menu does.
    mod.modResults.NSPhotoLibraryAddUsageDescription = "Bay saves images you ask for to your photo library.";
    // Voice search (B16): the microphone and speech recognition are asked for when the user taps the mic button.
    mod.modResults.NSMicrophoneUsageDescription = "Bay uses the microphone to search by voice.";
    mod.modResults.NSSpeechRecognitionUsageDescription = "Bay turns your words into a search on the device.";
    // App-icon quick actions (B15): each type is the bundle id and a command; BayShortcuts opens the matching
    // `bay://` command, which BrowserScreen answers like any incoming link.
    const bundleId = config.ios?.bundleIdentifier ?? "in.krishkalaria.bay.mobile";
    mod.modResults.UIApplicationShortcutItems = [
      { UIApplicationShortcutItemType: `${bundleId}.new-tab`, UIApplicationShortcutItemTitle: "New tab" },
      { UIApplicationShortcutItemType: `${bundleId}.private-tab`, UIApplicationShortcutItemTitle: "Private tab" },
    ];
    // iOS 26 keeps a download running after Bay leaves the screen as a continued-processing task, one identifier per
    // download (BayDownloads.swift). Without this entry, registering one would crash, so BayDownloads checks for it.
    const downloadTasks = `${config.ios?.bundleIdentifier ?? "in.krishkalaria.bay.mobile"}.download.*`;
    const permitted = mod.modResults.BGTaskSchedulerPermittedIdentifiers ?? [];

    if (!permitted.includes(downloadTasks)) mod.modResults.BGTaskSchedulerPermittedIdentifiers = [...permitted, downloadTasks];

    return mod;
  });
  config = withEntitlementsPlist(config, (mod) => {
    if (defaultBrowser) mod.modResults["com.apple.developer.web-browser"] = true;

    if (webPasskeys) mod.modResults["com.apple.developer.web-browser.public-key-credential"] = true;

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
      // Video can leave the page into picture in picture (B17): the activity must say so. The config changes that
      // picture in picture brings (the screen shrinks) are already in the list Expo writes, so the activity is not
      // recreated mid-playback; "pictureInPicture" is not a configChanges flag, and naming it fails the build.
      activity.$["android:supportsPictureInPicture"] = "true";

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

      // App-icon quick actions (B15): the res files (shortcuts.xml, search widget) live in the engine's own res
      // dir, which resource linking merges into the app; the manifest only points at them.
      if (!activity["meta-data"]?.some((entry) => entry.$["android:name"] === "android.app.shortcuts")) {
        activity["meta-data"] = [...(activity["meta-data"] ?? []), { $: { "android:name": "android.app.shortcuts", "android:resource": "@xml/shortcuts" } }];
      }

      application.$["android:usesCleartextTraffic"] = "true";
    }

    // The home-screen search widget (B15): a receiver for the launcher's updates; tapping it opens `bay://search`.
    if (application && !application.receiver?.some((entry) => entry.$["android:name"] === "expo.modules.bayengine.BaySearchWidget")) {
      application.receiver = [
        ...(application.receiver ?? []),
        {
          $: { "android:name": "expo.modules.bayengine.BaySearchWidget", "android:exported": "false", "android:label": "Search Bay" },
          "intent-filter": [{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] }],
          "meta-data": [{ $: { "android:name": "android.appwidget.provider", "android:resource": "@xml/search_widget_info" } }],
        },
      ];
    }

    return mod;
  });

  config = withChromiumEngine(config);

  return withXcodeProject(config, (mod) => {
    const bundleId = config.ios?.bundleIdentifier ?? "in.krishkalaria.bay.mobile";

    addAppExtension(mod.modResults, bundleId, {
      targetName: "BayShare",
      subfolder: "../share-extension/BayShare",
      bundleIdSuffix: "share",
      plist: shareExtensionInfoPlist,
      sources: shareExtensionSources,
    });
    addAppExtension(mod.modResults, bundleId, {
      targetName: "BayWidgets",
      subfolder: "../widget-extension/BayWidget",
      bundleIdSuffix: "widgets",
      plist: widgetExtensionInfoPlist,
      sources: widgetExtensionSources,
    });

    return mod;
  });
};

// Bay's Chromium on Android (bay-engine.aar, which scripts/fetch-android-engine.mjs installs as a local Maven
// repository under android/engine): the app resolves the engine from that repository, needs Android 10 as the
// engine does, keeps the engine's resource packs uncompressed (Chromium maps them straight out of the APK), and starts
// none of its own code in the engine's renderer and GPU processes, which run the app's Application class too.
function withChromiumEngine(config) {
  config = withProjectBuildGradle(config, (mod) => {
    mod.modResults.contents = chromiumEngineEdits.projectBuildGradle(mod.modResults.contents);

    return mod;
  });
  config = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = chromiumEngineEdits.appBuildGradle(mod.modResults.contents);

    return mod;
  });

  return withMainApplication(config, (mod) => {
    mod.modResults.contents = chromiumEngineEdits.mainApplication(mod.modResults.contents);

    return mod;
  });
}

// Each edit leaves a file it has already made alone, so prebuilding twice changes nothing.
const chromiumEngineEdits = {
  projectBuildGradle(gradle) {
    const repository = `maven { url "\${rootDir}/../modules/bay-engine/android/engine/repo" } // bay-engine`;

    if (!gradle.includes("// bay-engine")) {
      gradle = gradle.replace(/allprojects\s*\{\s*repositories\s*\{/, (match) => `${match}\n    ${repository}`);
    }

    if (!gradle.includes("ext.minSdkVersion = 29")) {
      gradle = gradle.replace(
        /^apply plugin: "expo-root-project"/m,
        (match) => `// Bay's Chromium engine runs on Android 10 and later.\next.minSdkVersion = 29\n\n${match}`,
      );
    }

    return gradle;
  },

  appBuildGradle(gradle) {
    if (gradle.includes("noCompress")) return gradle;

    return gradle.replace(/androidResources\s*\{/, (match) => `${match}\n        noCompress += ["pak", "dat", "bin"]`);
  },

  mainApplication(source) {
    if (source.includes("BayEngineApplication")) return source;

    source = source.replace(
      /^import android\.app\.Application$/m,
      (match) => `${match}\nimport android.content.Context\nimport org.bay.engine.BayEngineApplication`,
    );

    source = source.replace(
      /^[ \t]*override fun onConfigurationChanged\(newConfig: Configuration\) \{\n([ \t]*)super\.onConfigurationChanged\(newConfig\)\n/m,
      (match, body) => `${match}${body}if (!appProcess) return\n`,
    );

    return source.replace(
      /^([ \t]*)override fun onCreate\(\) \{\n([ \t]*)super\.onCreate\(\)\n/m,
      (match, indent, body) =>
        `${indent}/** False in the engine's own child processes, where none of the app starts. */\n` +
        `${indent}private var appProcess = true\n\n` +
        `${indent}override fun attachBaseContext(base: Context) {\n` +
        `${body}super.attachBaseContext(base)\n` +
        `${body}appProcess = BayEngineApplication.attachBaseContext(this)\n` +
        `${indent}}\n\n` +
        `${match}` +
        `${body}if (!appProcess) return\n` +
        `${body}BayEngineApplication.onCreate(this)\n`,
    );
  },
};

module.exports.chromiumEngineEdits = chromiumEngineEdits;

// The share extension (B14) is the only way to appear in a share sheet on iOS, and the search widget (B15) only
// through a WidgetKit target. Both keep their sources as plain files next to the app (share-extension/ and
// widget-extension/, which prebuild never touches), and this wires the Xcode targets themselves. node-xcode's
// addTarget does most of it: the target, its product, the embed phase on Bay and the Sources phase's files. The
// rest is done by hand here, for two node-xcode quirks: `updateBuildProperty` matches targets by comment, where
// the created name is already quoted, and `addTargetDependency` writes nothing at all when a fresh project lacks
// its sections.
function addAppExtension(project, bundleId, { targetName, subfolder, bundleIdSuffix, plist, sources }) {
  if (findTargetKeyFor(project, targetName)) return;

  const extension = project.addTarget(targetName, "app_extension", subfolder, `${bundleId}.${bundleIdSuffix}`);

  // So building Bay builds the extension before embedding it. A fresh Expo project has neither section yet.
  const objects = project.hash.project.objects;
  objects.PBXContainerItemProxy ??= {};
  objects.PBXTargetDependency ??= {};
  project.addTargetDependency(project.getFirstTarget().uuid, [extension.uuid]);

  // The Sources phase: addTarget creates none, so the extension's Swift files get one of their own.
  project.addBuildPhase(sources, "PBXSourcesBuildPhase", "Sources", extension.uuid);

  // The extension matches Bay's own deployment target and builds like it does; its plist, sources and bundle id
  // come from addTarget and the constants above.
  const minimum = unquote(project.getBuildProperty("IPHONEOS_DEPLOYMENT_TARGET"));

  const settings = {
    INFOPLIST_FILE: plist,
    SWIFT_VERSION: '"5.0"',
    TARGETED_DEVICE_FAMILY: '"1,2"',
    IPHONEOS_DEPLOYMENT_TARGET: `"${minimum}"`,
  };

  for (const item of project.pbxXCConfigurationList()[extension.pbxNativeTarget.buildConfigurationList].buildConfigurations) {
    const config = project.pbxXCBuildConfigurationSection()[unquote(item?.value ?? item)];

    if (config) Object.assign(config.buildSettings, settings);
  }
}

function findTargetKeyFor(project, targetName) {
  const targets = project.pbxNativeTargetSection() ?? {};

  for (const [key, target] of Object.entries(targets)) {
    if (!key.endsWith("_comment")) continue;

    if (unquote(target?.name) === targetName) return key;
  }

  return null;
}

function unquote(value) {
  return String(value ?? "").replace(/^"(.*)"$/, "$1");
}
