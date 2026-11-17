# Bay for Android (native)

The native Kotlin/Compose rewrite of `apps/mobile` (plan: `docs/mobile-native-plan.html`). minSdk 29, arm64-v8a only.

- Build: `./gradlew :app:assembleDebug` (needs `local.properties` with `sdk.dir`, or `ANDROID_HOME`). `:core:bindings` builds the Rust core with `cargo ndk` and generates its Kotlin API with UniFFI; install `cargo-ndk` with `cargo install cargo-ndk` and use rustup's toolchain.
- Modules use the convention plugins in `build-logic`: `bay.android.application`, `bay.android.library`, `bay.android.compose`. Versions live in `gradle/libs.versions.toml`.
- UI is Compose on Foundation: no Material or AppCompat dependency in UI modules (plan D8).
- Debug installs as `in.krishkalaria.bay.mobile.native`, beside the Expo app; release keeps the store ID.
- Drive the emulator with Argent (`reinstall-app` with the APK, `launch-app` with activity `bay.app.MainActivity`). Root composables set `testTagsAsResourceId`, and controls take `testTag`s equal to the Expo app's `testID`s.
- Words come from the core's catalog through `Strings` (`strings.t("key", mapOf("name" to value))`), never hard-coded text.
- Every Activity calls `window.decorView.announceContentChangesToUiAutomator()` after `setContent` (debug builds only). Compose sends accessibility events only while an accessibility *service* is on, and UiAutomator (Argent, e2e) isn't one, so without this its cache keeps the first frame it read and `describe`/`await-ui-element` see a stale screen.
- The page engine is the `:engine` module (package `bay.engine`), ported from the Expo module (`apps/mobile/modules/bay-engine/android`): `BayEngineView` (a `FrameLayout` over the engine's `BayTab`) reports everything through `onEvent` as one `EngineEvent`, and `Engine` holds what all views share. `MainActivity` is the `EngineHost` (activity, runtime permissions, activity results); `BayApplication` starts the engine and keeps the app out of the engine's child processes.
- It builds against Bay's Chromium (`bay-engine.aar`), installed by `node apps/mobile/scripts/fetch-android-engine.mjs` into the Expo module's `android/engine` folder, which `settings.gradle.kts` reads (`-PbayEngineDir=…` points elsewhere). New engine API (like `BayProfile.forSpace`) needs an `android-engine-N` run before the app can call it; until then stub the call locally and never commit the stub.
