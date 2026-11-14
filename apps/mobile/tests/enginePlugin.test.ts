import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

// SAFETY: app.plugin.js is CommonJS without types; chromiumEngineEdits is the object of three string edits it exports.
const { chromiumEngineEdits } = require("../modules/bay-engine/app.plugin.js") as {
  chromiumEngineEdits: Record<"projectBuildGradle" | "appBuildGradle" | "mainApplication", (text: string) => string>;
};

// The parts of Expo's Android template that the Chromium engine's edits touch.
const projectBuildGradle = `allprojects {
  repositories {
    google()
    mavenCentral()
  }
}

apply plugin: "expo-root-project"
`;

const appBuildGradle = `android {
    androidResources {
        ignoreAssetsPattern '!.svn'
    }
}
`;

const mainApplication = `package app

import android.app.Application
import android.content.res.Configuration

class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
`;

test("the project resolves the engine's Maven repository and needs Android 10", () => {
  const edited = chromiumEngineEdits.projectBuildGradle(projectBuildGradle);

  assert.match(edited, /repositories \{\n {4}maven \{ url "\$\{rootDir\}\/\.\.\/modules\/bay-engine\/android\/engine\/repo" \}/);
  assert.match(edited, /ext\.minSdkVersion = 29\n\napply plugin: "expo-root-project"/);
});

test("the engine's resource packs stay uncompressed", () => {
  assert.match(chromiumEngineEdits.appBuildGradle(appBuildGradle), /androidResources \{\n {8}noCompress \+= \["pak", "dat", "bin"\]/);
});

test("the app starts nothing of its own in the engine's child processes", () => {
  const edited = chromiumEngineEdits.mainApplication(mainApplication);

  assert.match(edited, /import org\.bay\.engine\.BayEngineApplication/);
  assert.match(edited, /appProcess = BayEngineApplication\.attachBaseContext\(this\)/);
  assert.match(edited, /super\.onCreate\(\)\n {4}if \(!appProcess\) return\n {4}BayEngineApplication\.onCreate\(this\)\n {4}loadReactNative/);
  assert.match(edited, /super\.onConfigurationChanged\(newConfig\)\n {4}if \(!appProcess\) return\n/);
});

test("prebuilding twice changes nothing more", () => {
  for (const [edit, text] of [
    [chromiumEngineEdits.projectBuildGradle, projectBuildGradle],
    [chromiumEngineEdits.appBuildGradle, appBuildGradle],
    [chromiumEngineEdits.mainApplication, mainApplication],
  ] as const) {
    const once = edit(text);

    assert.equal(edit(once), once);
  }
});
