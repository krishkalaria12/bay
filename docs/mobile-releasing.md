# Releasing the phone apps

Bay for iPhone is `apps/ios` (SwiftUI, a Tuist project) and Bay for Android is `apps/android` (Kotlin and Compose),
both on the Rust core in `packages/mobile-core` ([the plan](mobile-native-plan.html)). The desktop app's release is
separate: `docs/releasing.md` covers the Mac build, this file covers the two stores.

Android renders with Bay's own Chromium ([the Chromium implementation plan](android-chromium-plan.html)); iOS keeps
WebKit. The engine and the Android APK are built on GitHub's Linux runners: see [Android builds](#android-builds).

## Versions

The version that ships is `MARKETING_VERSION` in `apps/ios/Project.swift` and `versionName` in
`apps/android/app/build.gradle.kts`. Keep the two the same, and bump both in one pull request before a build. iOS's
build number is `CURRENT_PROJECT_VERSION`; Android's `versionCode` is the CI run number for the APKs CI publishes.

## One-time setup

1. **Apple.** An Apple Developer account and Bay's App Store Connect record. Apple's
   `com.apple.developer.web-browser` entitlement is granted on request, and it is what lets Bay be the default browser
   and take part in AutoFill. Until it is granted, generate the project without `TUIST_BAY_DEFAULT_BROWSER=1`: only
   builds made with it claim the entitlement.

2. **Google.** A Google Play developer account and the Play app with its testing track. The release key is the one in
   the repository secrets (below); keep the key itself outside the repository.

## iOS

```bash
cd apps/ios
TUIST_BAY_DEFAULT_BROWSER=1 scripts/generate.sh   # without the variable until Apple grants the entitlement
xcodebuild -workspace Bay.xcworkspace -scheme Bay -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Bay.xcarchive archive
```

Upload the archive from Xcode's Organizer (or `xcodebuild -exportArchive` with an App Store export options file) to
TestFlight. Apple reviews it (usually a day or two), then it can be submitted to the App Store from App Store Connect.

## Android builds

`.github/workflows/android-engine.yml` builds Bay's engine (`bay-engine.aar`, from `engine/android`) over up to six
chained stages, then the app around it, and publishes both as a prerelease named after the tag:

```bash
git tag android-engine-N && git push origin android-engine-N
```

A run whose engine sources haven't changed since an earlier one reuses that engine and only builds the app. The APK is
signed with Bay's release key from the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. An APK signed with any other key can't update an installed Bay, so the
key must never be lost or replaced. Without the secrets (a fork), the APK is signed with a throwaway debug key.

To build the app yourself, pin a published engine in `apps/android/engine-pin.json` (the release notes print the line to
use) and run `node apps/android/scripts/fetch-engine.mjs`; a built engine on disk installs with `--from <directory>`. An
Android build stops if no engine is installed. For the Play Store, build the bundle with `./gradlew :app:bundleRelease`
in `apps/android` and sign it with the same key.

If the Play account is new, Google requires a closed test with 12 testers for 14 days before an app can go to
production, so start the closed test early: it is the long pole, not the build.

Before 22 December 2026, the app should be installable from a link: Android users lose Arc Search for Android from the
Play Store on that date, and the switch guide on the site says so (`apps/web/src/pages/switch-from-arc.astro`).

## Checks before a build

The build is not the place to find a broken tree:

```bash
cargo test --manifest-path packages/mobile-core/Cargo.toml
pnpm --filter @bay/mobile-pagescripts test
apps/mobile-e2e/run        # every Argent flow on the Android emulator
```

`apps/mobile-e2e/run` needs the debug build installed. Argent's runner can't drive the iPhone app's flows yet (the
plan's Known gaps), so check them there by hand: the app is one design on two platforms, and each platform's own UI
breaks on its own.

## What is not automated yet

- The iOS archive and upload, and both store submissions, are done by hand.
- The version bump and the release notes for the stores are written by hand.
- The Mac app's nightly (`docs/releasing.md`) does not cover the phone apps: they release on their own schedule.
