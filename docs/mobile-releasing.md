# Releasing the mobile app

Bay for iPhone and Android lives in `apps/mobile` (Expo SDK 58). The desktop app's release is separate: `docs/releasing.md`
covers the Mac build, this file covers the two stores.

The plan behind it is `docs/mobile-plan.html`; item B8 is the release setup and stage 3 is the first public release.
Android renders with Bay's own Chromium ([the Chromium implementation plan](android-chromium-plan.html)); iOS keeps WebKit.
The engine and the Android APK are built on GitHub's Linux runners, not EAS: see [Android builds](#android-builds).

## What ships

| Profile | What it is | Who gets it |
| --- | --- | --- |
| `development` | A dev client, loaded from Metro | You, on your own devices |
| `preview` | An internal build: an `.apk` for Android, an `.ipa` for iOS | Testers, from a link |
| `production` | A store build: an `.aab` for Android, an `.ipa` for iOS | TestFlight and Google Play |

The profiles are in `apps/mobile/eas.json`. The version that ships is the one in `apps/mobile/app.json`
(`appVersionSource: local`), so the two stores never disagree about it: bump it in a pull request, before the build.

## One-time setup

1. **The EAS project.** From `apps/mobile`:

   ```bash
   pnpm dlx eas-cli init
   ```

   It writes the project id into `apps/mobile/app.json` under `extra.eas.projectId` and links the project to the Expo
   account. One project holds both platforms.

2. **A token for CI.** Create one at <https://expo.dev/accounts/settings/access-tokens> and add it to the repository as
   the `EXPO_TOKEN` secret. `.github/workflows/mobile.yml` builds with it.

3. **Apple.** An Apple Developer account, and an App Store Connect API key (issuer id, key id, the `.p8` file) added to EAS
   with `eas credentials`. The first build then creates Bay's App Store Connect record.

   Apple's `com.apple.developer.web-browser` entitlement is granted by Apple on request, and it is what lets Bay be the
   default browser and take part in AutoFill (B9, B20). Until it is granted, build with `BAY_DEFAULT_BROWSER=1` off: the
   config plugin only claims the entitlement behind that flag.

4. **Google.** A Google Play service account key with release rights, added to EAS with `eas credentials`. The first
   production build creates the Play app and its testing track.

## A preview build

```bash
cd apps/mobile
pnpm dlx eas-cli build --platform all --profile preview
```

Or from Actions: `gh workflow run mobile.yml -f profile=preview -f platform=all`. EAS prints a link (and a QR code) that
installs the build on a device; for iOS the link needs a device with the app's ad-hoc provisioning, so add testers in EAS
first (`eas device:configure`).

## The first public release

1. Bump the version in `apps/mobile/app.json` and open a pull request.
2. Build the production profile:

   ```bash
   cd apps/mobile
   pnpm dlx eas-cli build --platform all --profile production
   ```

3. **iOS.** The build uploads to TestFlight. Apple reviews it (usually a day or two), then it can be submitted to the App
   Store for review from App Store Connect.

4. **Android.** The build uploads to the Play Console's testing track. If the account is new, Google requires a closed test
   with 12 testers for 14 days before it can go to production, so start the closed test early: it is the long pole, not the
   build.

5. Before 22 December 2026, the app should be installable from a link: Android users lose Arc Search for Android from the
   Play Store on that date, and the switch guide on the site says so (`apps/web/src/pages/switch-from-arc.astro`).

## What is not automated yet

- The store submissions are done by hand from App Store Connect and the Play Console; `eas submit` in `eas.json` is there
  for when that changes.
- The version bump and the release notes for the stores are written by hand.
- The Mac app's nightly (`docs/releasing.md`) does not cover the mobile app: they release on their own schedule.

## Checks before a build

The build is not the place to find a broken tree:

```bash
cd apps/mobile
pnpm typecheck
pnpm test
pnpm e2e        # every Argent flow, on the iPhone simulator and the Android emulator
```

`pnpm e2e` needs both dev clients installed (`pnpm native`) and Metro running (`pnpm start`). Both devices must be
available: the app is one design on two platforms, and Android's own UI breaks on its own.

## Android builds

`.github/workflows/android-engine.yml` builds Bay's engine (`bay-engine.aar`, from `engine/android`) over up to six
chained stages, then the app around it, and publishes both as a prerelease named after the tag:

```bash
git tag android-engine-N && git push origin android-engine-N
```

A run whose engine sources haven't changed since an earlier one reuses that engine and only builds the app. The APK is
signed with Bay's release key from the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. The key itself is kept outside the repository: an APK signed with any
other key can't update an installed Bay, so it must never be lost or replaced. Without the secrets (a fork), the APK
keeps the debug signature.

To build the app yourself, pin a published engine in `apps/mobile/android-engine.json` (the release notes print the
line to use) and run `node scripts/fetch-android-engine.mjs` from `apps/mobile`; `pnpm native` does this for you. A
built engine on disk installs with `--from <directory>`. An Android build stops if no engine is installed.

