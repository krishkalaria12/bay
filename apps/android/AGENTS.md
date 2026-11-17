# Bay for Android (native)

The native Kotlin/Compose rewrite of `apps/mobile` (plan: `docs/mobile-native-plan.html`). minSdk 29, arm64-v8a only.

- Build: `./gradlew :app:assembleDebug` (needs `local.properties` with `sdk.dir`, or `ANDROID_HOME`). `:core:bindings` builds the Rust core with `cargo ndk` and generates its Kotlin API with UniFFI; install `cargo-ndk` with `cargo install cargo-ndk` and use rustup's toolchain.
- Modules use the convention plugins in `build-logic`: `bay.android.application`, `bay.android.library`, `bay.android.compose`. Versions live in `gradle/libs.versions.toml`.
- UI is Compose on Foundation: no Material or AppCompat dependency in UI modules (plan D8).
- Debug installs as `in.krishkalaria.bay.mobile.native`, beside the Expo app; release keeps the store ID.
- Drive the emulator with Argent (`reinstall-app` with the APK, `launch-app` with activity `bay.app.MainActivity`). Root composables set `testTagsAsResourceId`, and controls take `testTag`s equal to the Expo app's `testID`s.
