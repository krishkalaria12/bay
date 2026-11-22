# Releasing

Bay has two channels, both built, signed, notarized and published by `.github/workflows/release.yml`:

- **Nightly**, every night at 02:30 IST, of `main`, when the app (`apps/browser`, `packages`, `engine`) changed since
  the last release. For testers: fast, tested less. Nobody needs to do anything.
- **Stable**, only when you ask for it.

## Channels

One feed, `appcast.xml` on the latest stable GitHub release (`SUFeedURL`, `baybrowser.in/appcast.xml`, redirects
there). A stable item has no channel; a nightly's carries `<sparkle:channel>nightly</sparkle:channel>`
(`generate_appcast --channel nightly`). Sparkle skips an item on a channel the app doesn't allow and allows none by
default, so every copy on Stable, and every build shipped before channels existed, only sees stable items. A copy on
Nightly allows `nightly` (`allowedChannels(for:)` in `packages/desktop/ios/Updater.swift`) and gets the newest of both.

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
- **Downloads.** Stable: `baybrowser.in/download` (`Bay.dmg` on the latest release). Nightly:
  `baybrowser.in/nightly` (`apps/web/public/_redirects`), `Bay-Nightly.dmg` on the prerelease `nightly`, which
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
  archive, signed ad hoc) and uploads it. Before the archive, `packages/desktop/scripts/test-updater.mjs` checks channel
  selection and the pending-install guard against Sparkle's development framework from Pods.
- **sign** restores no cache and installs nothing but Sparkle's own pinned tools, so no dependency code runs next to
  the keys, and treats the build as untrusted (`.github/release/unpack-build.py`). `.github/release/signing.sh` puts
  the identity in a temporary keychain and the profile, notary and Sparkle keys in files; `release.sh --phase sign`
  exports the archive by hand (`scripts/lib/export-developer-id.sh`, Xcode's export needs a signed-in account),
  strips and signs Chrome's framework, verifies, notarizes and staples the app and DMG, and writes the notes and
  appcast. A step written in the workflow removes the keychain and key files, the run fails if the checkout changed,
  and only then the launch check runs (`--phase check`: the final app opened hidden, the content blocker must block an
  ad request, the signature must survive) and `.github/release/check-sparkle.sh` checks the zip's EdDSA signature against the app's
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
`packages/chromium/prebuilt-engines.tsv`: commit and push that line. Until then, releases of a commit whose `engine/`
changed fail in **plan**, saying so; `engine/` must be committed and pushed first.

## Linux

Linux has its own versions, starting at 1.0.0, apart from the Mac's: its packages go on the release `linux-v<version>`,
which `publish.sh` creates and never marks latest (the site's `/download` and the Mac appcast follow the latest release).
Notes for it can go in `release-notes/linux/<version>.md`, whose `date:` also dates the AppStream release. One run of
`.github/workflows/linux-build.yml` builds (or reuses) the engine, packages and checks the AppImage, then its
**publish** job runs `scripts/linux/publish.sh`:

```bash
gh workflow run linux-build.yml -f version=<version> -f publish=true
```

Its **plan** job fails at once, before the engine, if the version isn't X.Y.Z, `linux-v<version>` already has its
packages or a secret below is missing. Without `publish` the run is an ordinary test build. To see what a release would
upload without uploading it, run `publish.sh --dry-run` on a run's `bay-linux-packages` with any key in `BAY_GPG_KEY`.

What a release publishes:

| Where | What |
|---|---|
| Release `linux-v<version>` | the `.deb`, signed `.rpm`, tarball, AppImage and its `.zsync`, NixOS closure, `bay-<version>-linux-SHA256SUMS`, and an `.asc` signature for each |
| Prerelease `linux-repo` | the APT repository (`InRelease`, `Release`, `Packages`), the RPM repository (`repomd.xml` and its metadata), the keys `bay.gpg` and `bay.asc`, `bay.repo`, and `Bay-x86_64.AppImage.zsync`, which points at this release's AppImage. Each release replaces them |
| AUR `bay-browser-bin` | `PKGBUILD` and `.SRCINFO`; the package downloads the release's tarball |
| Snap Store `bay-browser` | the snap, on stable, when `SNAPCRAFT_STORE_CREDENTIALS` is set |

Flathub and nixpkgs build from the release's tarball, and their bots open a pull request for each new release once the
first is in: Flathub's checks GitHub's releases every few hours and merges its own (`flathub.json`), and nixpkgs'
(r-ryantm) runs the package's update script. The run's `bay-linux-packages` holds the files for the first pull
requests: `flatpak/` and `nixpkgs/package.nix`.

The site serves both repositories at `baybrowser.in/linux/` (`apps/web/public/_redirects`): indexes and keys
redirect to `linux-repo`, and each package to its release, so `apt`, `dnf` and `zypper` download from GitHub. The
repositories list only the newest release. The redirects deploy with the site from `main`, so they have to be there
before the first Linux release. Users set it up with `docs/linux-install.md`.

### One-time setup

1. **Signing key.** Every installed copy trusts this key from then on, so keep it backed up with the other signing files
   and never replace it lightly. RSA keeps older rpm and zypper happy; no passphrase, since the secret is the protection.

   ```bash
   gpg --batch --passphrase '' --quick-gen-key 'Bay Linux packages' rsa4096 sign 0
   key=$(gpg --list-secret-keys --with-colons 'Bay Linux packages' | awk -F: '$1 == "fpr" { print $10; exit }')
   gpg --armor --export-secret-keys "$key" >~/Documents/bay-linux-keys/bay-linux-signing-key.asc
   gh secret set LINUX_GPG_PRIVATE_KEY <~/Documents/bay-linux-keys/bay-linux-signing-key.asc
   ```

2. **AUR.** Make an account at aur.archlinux.org, then give CI a key of its own (the account takes several, one per line):

   ```bash
   ssh-keygen -t ed25519 -N '' -C bay-aur-ci -f ~/Documents/bay-linux-keys/aur-ci
   # aur.archlinux.org › My Account › SSH Public Key: add ~/Documents/bay-linux-keys/aur-ci.pub
   gh secret set AUR_SSH_PRIVATE_KEY <~/Documents/bay-linux-keys/aur-ci
   ```

   The first publish creates `bay-browser-bin`. `publish.sh` checks the AUR's published host key.

3. **Site.** Get the `/linux/` lines of `apps/web/public/_redirects` onto `main` and deployed.

After the first release:

4. **Flathub.** First add two or three screenshots of Bay on Linux to `packaging/linux/in.krishkalaria.bay.metainfo.xml`
   (`<screenshots>`, with images at stable `https://baybrowser.in/...` URLs): Flathub's linter refuses an app
   without them, and the site's are the Mac app's. Then fork `flathub/flathub`, branch from `new-pr`, add the files from `bay-linux-packages/flatpak/` and open a
   pull request into `new-pr` titled "Add in.krishkalaria.bay". Reviewers build it and may ask for changes; once it's
   merged, Flathub makes `flathub/in.krishkalaria.bay` and you're its maintainer. For the verified badge, sign in at
   flathub.org and verify the domain `krishkalaria.in`, which the app ID names.
5. **Snap Store.** Register the name (`bay` was taken, so it's `bay-browser`) and ask for the sandbox, which
   Chromium-based snaps need and the store grants by hand: a post in forum.snapcraft.io's "store-requests" asking for
   `browser-support` with `allow-sandbox` for `bay-browser`. Mention the `mpris` slot too: it's named `bay`, which isn't
   the snap's name.

   ```bash
   snapcraft register bay-browser
   snapcraft export-login --snaps=bay-browser --channels=stable --acls package_access,package_push,package_release - \
     | gh secret set SNAPCRAFT_STORE_CREDENTIALS
   ```

   The credentials last a year; export them again before they run out.

   The next release uploads it; the first one can be uploaded by hand with `snapcraft upload --release=stable`.
6. **nixpkgs.** Add yourself to `maintainers/maintainer-list.nix` and `bay-linux-packages/nixpkgs/package.nix` as
   `pkgs/by-name/ba/bay-browser/package.nix` (filling in `maintainers`), check it with `nix-build -A bay-browser`, and open the pull
   request.

The `.deb` doesn't add the APT repository on its own, so a `.deb` installed by hand doesn't update.

## Reading a Linux or Windows crash report

Crash reports from the desktop host name each frame by module and offset: a minidump has no symbols. Linux builds keep
frame pointers, so a report has its stack; Windows x64 builds don't, so one has the crashing frame alone. Both ship
Crashpad (`chrome_crashpad_handler` on Linux, `chrome_elf.dll` on Windows), and `engine.py` keeps each release's symbols
in its `-symbols` archive. With the archive that matches the report's version:

```bash
llvm-symbolizer --obj=symbols/.debug/bay.debug 0x<offset>      # Linux
llvm-symbolizer --obj=chrome.dll.pdb 0x<offset>                # Windows
```
