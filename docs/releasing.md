# Releasing

Bay has two channels, both built, signed, notarized and published by `.github/workflows/release.yml`:

- **Nightly**, every night at 02:30 IST, of `main`, when the app (`apps/browser`, `packages`, `engine`) changed since
  the last release. For testers: fast, tested less. Nobody needs to do anything.
- **Stable**, only when you ask for it.

## Channels

One feed, `appcast.xml` on the latest stable GitHub release (`SUFeedURL`, `bay.krishkalaria.in/appcast.xml`, redirects
there). A stable item has no channel; a nightly's carries `<sparkle:channel>nightly</sparkle:channel>`
(`generate_appcast --channel nightly`). Sparkle skips an item on a channel the app doesn't allow and allows none by
default, so every copy on Stable, and every build shipped before channels existed, only sees stable items. A copy on
Nightly allows `nightly` (`allowedChannels(for:)` in `packages/shell/ios/Updater.swift`) and gets the newest of both.

- **Which channel a copy is on.** Settings › General › Update channel, kept in the defaults key `NNUpdateChannel`.
  Until the user picks, it's the channel of the build that first ran (`BayUpdateChannel` in Info.plist, which
  `release.sh --channel nightly` sets through the build setting `BAY_UPDATE_CHANNEL`). It's written at the first
  launch, so a nightly copy stays on Nightly after it updates to a stable build. Switching to Stable never downgrades:
  Sparkle only offers a higher build, so the copy waits for the next stable. Channel changes are disabled while an
  update is in progress, including a downloaded update waiting to install, because Sparkle has already selected it.
- **Versions.** Sparkle compares the build number (`sparkle:version`); the version string is only shown. A nightly is
  `<next patch>-nightly.<n>` (`scripts/release/next-nightly.sh`), with build `<newest stable build>.<n>`, so
  1.5.2 (42) < 1.5.3-nightly.1 (42.1) < 1.5.3-nightly.2 (42.2) < 1.5.3 (43). Nightlies don't touch the project's
  version: they're built with `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` overridden. `release.sh` and
  `publish.sh` refuse a build that isn't above every build in the published feed.
- **Feed.** A stable release publishes the merged feed as its own asset and becomes latest. A nightly is a GitHub
  prerelease (so latest, `/download` and the feed's home stay on stable) and re-uploads the merged feed onto the latest
  stable release. `publish.sh` merges the new item onto the feed as published at that moment, keeping the newest 3
  per channel, and deletes nightly releases beyond the newest 5 (never one the feed still lists).
- **Downloads.** Stable: `bay.krishkalaria.in/download` (`Bay.dmg` on the latest release). Nightly:
  `bay.krishkalaria.in/nightly` (`apps/web/public/_redirects`), `Bay-Nightly.dmg` on the prerelease `nightly`, which
  each nightly replaces.
- **Notes.** A stable's are `release-notes/<version>.md` (the site, the GitHub release and the update dialog). A
  nightly's are the `feat`, `fix` and `perf` commit subjects since the previous release
  (`scripts/release/nightly-notes.sh`), unless `release-notes/<version>.md` exists.

## Shipping a stable release

1. Write `release-notes/<version>.md` (`date:` and `headline:` frontmatter), set `MARKETING_VERSION` to `<version>`
   and bump `CURRENT_PROJECT_VERSION` by one in `apps/browser/macos/Bay.xcodeproj/project.pbxproj`, commit
   (`chore: prepare bay <version>`) and push to `main`.
2. If `engine/` changed since the last published engine, publish it (below).
3. Run it: Actions › Release › Run workflow › channel `stable`, version `<version>`, or

   ```bash
   gh workflow run release.yml -f channel=stable -f version=<version>
   ```

   `dry_run` builds and signs a candidate and publishes nothing.

Or on this Mac, as before: `bash scripts/release.sh <version>` (with
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`), then `scripts/release/publish.sh <version>`.

A nightly by hand: `gh workflow run release.yml` (`-f force=true` even if nothing changed), or locally
`bash scripts/release.sh "$(scripts/release/next-nightly.sh)" --channel nightly` and `publish.sh`.

## CI

- **plan** works out the version (the next nightly, or checks a stable's against `MARKETING_VERSION`, its notes and
  that it isn't out yet), skips a nightly when nothing changed, and fails at once if `engine/`'s tree has no prebuilt
  engine.
- **checks**: format, lint, types and the JavaScript tests.
- **build**, on `macos-26` with the newest released Xcode, with no secrets: fetches the engine for this exact
  `engine/` tree, installs (pnpm, Pods), runs `scripts/release.sh <version> --channel <channel> --phase build` (the
  archive, signed ad hoc) and uploads it. Before the archive, `packages/shell/scripts/test-updater.py` checks channel
  selection and the pending-install guard against Sparkle's development framework from Pods.
- **sign** restores no cache and installs nothing but Sparkle's own pinned tools, so no dependency code runs next to
  the keys, and treats the build as untrusted (`.github/release/unpack-build.py`). `.github/release/signing.sh` puts
  the identity in a temporary keychain and the profile, notary and Sparkle keys in files; `release.sh --phase sign`
  exports the archive by hand (`scripts/lib/export-developer-id.sh`, Xcode's export needs a signed-in account),
  strips and signs Chrome's framework, verifies, notarizes and staples the app and DMG, and writes the notes and
  appcast. A step written in the workflow removes the keychain and key files, the run fails if the checkout changed,
  and only then the launch check runs (`--phase check`: the final app opened hidden, uBO must be ready, the signature
  must survive) and `.github/release/check-sparkle.sh` checks the zip's EdDSA signature against the app's
  `SUPublicEDKey`. The dSYMs are kept as a 90-day artifact.
- **publish** runs `scripts/release/publish.sh`, which creates the tag at the built commit if it isn't there yet.

Secrets (repository secrets), set by `scripts/release/ci-secrets.sh` from `~/Documents/bay-developer-id`,
`scripts/.notary.env` and the login keychain:

| Secret | What |
|---|---|
| `MACOS_CERTIFICATE_P12` | base64 of a .p12 with the Developer ID Application certificate and its key |
| `MACOS_CERTIFICATE_PASSWORD` | that .p12's password |
| `MACOS_PROVISIONING_PROFILE` | base64 of the "Bay Developer ID" provisioning profile (the keychain groups need it) |
| `NOTARY_KEY_P8` | base64 of the App Store Connect API key `AuthKey_<id>.p8` |
| `NOTARY_KEY_ID`, `NOTARY_ISSUER` | that key's id and issuer id |
| `SPARKLE_ED_PRIVATE_KEY` | the file `generate_keys -x` writes |

A dry run without the notary secrets builds unnotarized; the others are required.

### Engines

The app links a prebuilt Chromium Framework, which a runner can't build. Build it here (BUILDING.md), then

```bash
scripts/publish-engine.sh --dry-run   # packs it and prints what it would do
scripts/publish-engine.sh
```

packs it unstripped (the symbols' copy; `release.sh` strips the app's), uploads it to the prerelease
`engine-<engine tree:12>` (never latest) and appends `<tree> engine-<tree:12> <sha256>` to
`packages/nncore/prebuilt-engines.tsv`: commit and push that line. Until then, releases of a commit whose `engine/`
changed fail in **plan**, saying so; `engine/` must be committed and pushed first.
