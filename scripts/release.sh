#!/usr/bin/env bash
# Builds a release:
#   scripts/release.sh <version>                     dist/<version>/: a stable release, what gets published
#   scripts/release.sh <version> --channel nightly   dist/<version>/: a nightly (<next stable>-nightly.<n>)
#   scripts/release.sh <version> --rc                dist/<version>-rc/: a candidate from the working tree, never published
#   … --phase build|sign|check                       one of CI's three steps (docs/releasing.md › CI)
#
# Archives the Release configuration of apps/browser/macos (arm64), exports it with Developer ID, signs Chrome's
# framework inside out the way Chrome signs its own (chrome/installer/mac/signing/parts.py), checks the signatures and
# what an in-place update from an earlier copy depends on, launches the app once hidden and checks its bundle is still
# sealed, notarizes and staples the app and the DMG, and writes Bay-<version>.dmg, Bay-<version>.zip
# (Sparkle's update archive), appcast.xml (signed with the Sparkle EdDSA key) and release-notes.md (the GitHub
# release's notes). scripts/release/publish.sh publishes them.
#
# A stable release needs release-notes/<version>.md, MARKETING_VERSION set to <version> (and CURRENT_PROJECT_VERSION
# bumped) and a clean tree under apps/browser, packages and engine. A nightly needs none of the version bump: it builds
# HEAD as <version>, build <newest stable build in the feed>.<n>, so it sorts after that stable and before the next
# (42 < 42.1 < 42.2 < 43), with notes from the commits since the previous release unless release-notes/<version>.md
# exists. Its appcast item is on Sparkle's nightly channel, which only copies on Nightly read. A candidate builds the
# working tree as <version> with the next build number, and uses the notes file if there is one.
#
# Phases (default: all of them, in one go, on this Mac):
#   build   the archive, signed ad hoc; no keys needed (CI's build job)
#   sign    export, strip, sign, verify, notarize, package, notes, appcast, from the archive in RELEASE_BUILD_INPUT
#           (or dist), with RELEASE_PROVISIONING_PROFILE; no launch (CI's sign job)
#   check   the launch check on dist's signed app, once the keys are gone
#
# NOTARY_PROFILE        notarytool keychain profile (default bay), unless scripts/.notary.env or NOTARY_KEY set an API key
# ALLOW_UNNOTARIZED=1   build anyway without notarizing
# SPARKLE_ACCOUNT       keychain account of the Sparkle key (default bay); SPARKLE_KEY_FILE a key file instead
# SPARKLE_BIN           Sparkle's tools (default the pod's)
# NNCORE_FRAMEWORK      another Chromium Framework.framework than out/Release_GN_arm64's (a prebuilt engine:
#                       packages/nncore/scripts/fetch-engine.sh), with NNCORE_FRAMEWORK_ENGINE the engine/ tree it was built from
# RELEASE_BUILD_DIR     the derived data folder (default apps/browser/build-release)
# RELEASE_BUILD_SETTINGS more xcodebuild settings (CI's compilation cache)
# RELEASE_PROVISIONING_PROFILE  the Developer ID profile: export by hand (scripts/lib/export-developer-id.sh) instead of Xcode
# APPCAST_BASE          the published feed this one builds on (URL, file, or none for the very first)
set -euo pipefail

usage="usage: scripts/release.sh <version> [--channel stable|nightly] [--rc] [--phase build|sign|check]"
version="${1:?$usage}"
shift
rc=0
channel=stable
phase=all
while [ $# -gt 0 ]; do
  case "$1" in
    --rc) rc=1 ;;
    --channel)
      channel="${2:-}"
      shift
      case "$channel" in stable | nightly) ;; *) echo "error: --channel is stable or nightly, got '$channel'" >&2; exit 1 ;; esac
      ;;
    --phase)
      phase="${2:-}"
      shift
      case "$phase" in build | sign | check) ;; *) echo "error: --phase is build, sign or check, got '$phase'" >&2; exit 1 ;; esac
      ;;
    *) echo "error: unknown option $1 ($usage)" >&2; exit 1 ;;
  esac
  shift
done
die() { echo "error: $*" >&2; exit 1; }
if [ "$channel" = nightly ]; then
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.([0-9]+)$ ]] \
    || die "a nightly's version is <next stable>-nightly.<n>, like 1.5.4-nightly.1 (got $version; scripts/release/next-nightly.sh)"
  nightly_n="${BASH_REMATCH[1]}"
else
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "a stable version is <major>.<minor>.<patch> (got $version; nightlies take --channel nightly)"
fi
root="$(cd "$(dirname "$0")/.." && pwd -P)"
app_dir="$root/apps/browser"
macos="$app_dir/macos"
nncore="$root/packages/nncore"
repo="krishkalaria12/bay"
bundle_id="in.krishkalaria.bay"
team="GP328GJT66"
notes_page="https://bay.krishkalaria.in/release-notes/"
notary_profile="${NOTARY_PROFILE:-bay}"
# App Store Connect API key for notarytool, when scripts/.notary.env (untracked) sets NOTARY_KEY (path to
# AuthKey_<id>.p8), NOTARY_KEY_ID and NOTARY_ISSUER. Preferred over the keychain profile: notarytool keeps that
# profile in the data-protection keychain, which reads as missing while the Mac's screen is locked.
[ -z "${NOTARY_KEY:-}" ] && [ -f "$root/scripts/.notary.env" ] && . "$root/scripts/.notary.env"
if [ -n "${NOTARY_KEY:-}" ]; then
  notary_auth=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
else
  notary_auth=(--keychain-profile "$notary_profile")
fi
sparkle_account="${SPARKLE_ACCOUNT:-bay}"
sparkle_key_file="${SPARKLE_KEY_FILE:-}"
sparkle="${SPARKLE_BIN:-$macos/Pods/Sparkle/bin}"
if [ "$rc" = 1 ]; then dist="$root/dist/$version-rc"; else dist="$root/dist/$version"; fi
# A candidate can go elsewhere (RC_DIST=dist/final-<version>-rc; keep the -rc ending, unregister-builds keeps those registered) while a copy of the last one is still open from its folder.
[ "$rc" = 1 ] && [ -n "${RC_DIST:-}" ] && dist="$(cd "$root" && mkdir -p "$RC_DIST" && cd "$RC_DIST" && pwd)"
build="${RELEASE_BUILD_DIR:-$app_dir/build-release}"
archive="$dist/Bay.xcarchive"
app="$dist/export/Bay.app"
zip="$dist/Bay-$version.zip"
dmg="$dist/Bay-$version.dmg"
chromium_src="${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}"
framework_src="${NNCORE_FRAMEWORK:-$chromium_src/out/Release_GN_arm64/Chromium Framework.framework}"
framework_engine="${NNCORE_FRAMEWORK_ENGINE:-}"
provisioning_profile="${RELEASE_PROVISIONING_PROFILE:-}"
read -r -a extra_build_settings <<<"${RELEASE_BUILD_SETTINGS:-}"
build_input="${RELEASE_BUILD_INPUT:-}"
if [ "$phase" = sign ] && [ -n "$build_input" ]; then
  archive="$build_input/Bay.xcarchive"
fi
if [ "$phase" = sign ] || [ "$phase" = check ]; then
  framework_src="$archive/Products/Applications/Bay.app/Contents/Frameworks/Chromium Framework.framework"
  [ "$phase" = check ] || [ -d "$archive" ] || die "no $archive: run --phase build first"
fi

launch_check() {
  echo "==> Launch check"
  # Running the app must leave its bundle as signed: anything written into it breaks the signature (Chrome indexing
  # uBlock's rulesets next to the extension did, in 0.1.0). Launch it hidden with a throwaway data dir, wait for uBlock
  # Origin to be ready and block an ad request, quit, verify again.
  check_data="$(mktemp -d "${TMPDIR:-/tmp}/nn-release.XXXXXX")"
  before="$(pgrep -f "^$app/Contents/MacOS/Bay" | sort || true)"
  check_port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
  open -g -n --env BAY_BACKGROUND=1 --env BAY_DATA_DIR="$check_data" --env BAY_REMOTE_DEBUGGING_PORT="$check_port" "$app"
  ubo_ok=0
  node "$root/scripts/lib/ubo-ready.mjs" "$check_port" 90 && ubo_ok=1
  sleep 5
  # The instance this launched: the one started with our data dir (a copy of the same build the owner is running
  # must never be the one quit or killed here).
  pid=""
  for p in $(pgrep -f "^$app/Contents/MacOS/Bay\$" || true); do
    ps -E -ww -o command= -p "$p" 2>/dev/null | grep -qF "BAY_DATA_DIR=$check_data" && { pid="$p"; break; }
  done
  [ -n "$pid" ] || pid="$(comm -13 <(echo "$before") <(pgrep -f "^$app/Contents/MacOS/Bay" | sort || true) | head -1)"
  [ -n "$pid" ] || die "the app didn't start (or quit)"
  kill -TERM "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -KILL "$pid" 2>/dev/null || true
  codesign --verify --deep --strict "$app" || die "running the app changed its bundle"
  [ "$ubo_ok" = 1 ] || die "uBlock Origin wasn't ready and blocking in the exported app (90 s)"
  rm -rf "$check_data"
}
if [ "$phase" = check ]; then
  [ -d "$app" ] || die "no $app: run --phase sign first"
  launch_check
  echo "Launch check passed: $app"
  exit 0
fi

# Every release builds on the published feed: it keeps the earlier versions and the other channel listed, and says
# which build numbers are taken.
feed_base="${APPCAST_BASE:-https://github.com/$repo/releases/latest/download/appcast.xml}"
base_feed="$(mktemp "${TMPDIR:-/tmp}/nn-appcast.XXXXXX")"
cleanup=("$base_feed")
trap 'rm -rf "${cleanup[@]}"' EXIT
case "$feed_base" in
  none) : >"$base_feed" ;;
  http://* | https://*) curl -fsL "$feed_base" -o "$base_feed" || : >"$base_feed" ;;
  *) cp "$feed_base" "$base_feed" ;;
esac
if [ ! -s "$base_feed" ] && [ "$rc" = 0 ] && [ "$feed_base" != none ]; then
  die "couldn't read the published appcast ($feed_base): every release builds on it, or earlier versions and the other channel drop out of the feed"
fi
feed_builds() { sed -n 's/.*<sparkle:version>\([^<]*\)<.*/\1/p' "$base_feed"; }
# Stable items carry no channel; their builds are whole numbers.
newest_stable_build="$(feed_builds | grep -E '^[0-9]+$' | sort -n | tail -1 || true)"
newest_listed="$(feed_builds | sort -V | tail -1 || true)"

# The version ships from the tagged commit: bump it in the project first. A candidate is <version> with the next
# build number, so it sorts after the published release in Sparkle. A nightly is <version> with the build after the
# newest stable's, whatever the project says.
pbx="$macos/Bay.xcodeproj/project.pbxproj"
project_version="$(sed -n 's/.*MARKETING_VERSION = \(.*\);/\1/p' "$pbx" | sort -u)"
project_build="$(sed -n 's/.*CURRENT_PROJECT_VERSION = \(.*\);/\1/p' "$pbx" | sort -u)"
version_settings=()
release_build="$project_build"
if [ "$channel" = nightly ]; then
  [ -n "$newest_stable_build" ] || [ "$rc" = 1 ] || die "the published feed has no stable build for a nightly to follow"
  release_build="${newest_stable_build:-$project_build}.$nightly_n"
  version_settings=(MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$release_build")
elif [ "$rc" = 1 ]; then
  [ "$project_version" = "$version" ] || {
    release_build="$((project_build + 1))"
    version_settings=(MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$release_build")
  }
elif [ "$project_version" != "$version" ]; then
  die "MARKETING_VERSION is '$project_version'. Set it to $version (and bump CURRENT_PROJECT_VERSION) first."
fi
# Sparkle offers a copy only a higher build (sparkle:version), so a build at or below one in the feed would never be
# offered, and a stable below a nightly would strand the nightly copies.
if [ "$rc" = 0 ] && [ -n "$newest_listed" ]; then
  [ "$release_build" != "$newest_listed" ] && [ "$(printf '%s\n%s\n' "$newest_listed" "$release_build" | sort -V | tail -1)" = "$release_build" ] \
    || die "build $release_build must be above every build in the feed, nightly or stable (newest: $newest_listed)$([ "$channel" = stable ] && echo ': bump CURRENT_PROJECT_VERSION')"
fi

# Written before the build: the website, the GitHub release and the update dialog all show it. A nightly without a
# notes file lists the commits since the previous release.
notes="$root/release-notes/$version.md"
if [ -f "$notes" ]; then
  frontmatter() { awk 'NR == 1 && $0 == "---" { inside = 1; next } inside && $0 == "---" { exit } inside' "$notes"; }
  notes_body() { awk 'NR == 1 && $0 == "---" { inside = 1; next } inside && $0 == "---" { inside = 0; next } !inside' "$notes" | sed '/./,$!d'; }
  meta="$(frontmatter)"
  headline="$(sed -n 's/^headline: *//p' <<<"$meta")"
  grep -Eq '^date: *[0-9]{4}-[0-9]{2}-[0-9]{2} *$' <<<"$meta" && [ -n "$headline" ] \
    || die "$notes needs 'date: YYYY-MM-DD' and 'headline:' frontmatter"
elif [ "$channel" = nightly ]; then
  headline="Nightly $version"
  notes_body() { "$root/scripts/release/nightly-notes.sh"; }
elif [ "$rc" = 1 ]; then
  headline="Release candidate $version"
  notes_body() { echo "A release candidate of Bay $version. Not published."; }
else
  die "no release notes: write release-notes/$version.md first"
fi

# A release ships a commit: anything uncommitted in the app's sources would ship with it (another agent's work in
# progress, say). A candidate builds the working tree and records what it included.
dirty="$(git -C "$root" status --porcelain -- apps/browser apps/cli packages engine | grep -v ' apps/browser/build' || true)"
if [ -n "$dirty" ]; then
  [ "$rc" = 1 ] || { echo "$dirty" >&2; die "uncommitted changes under apps/browser, apps/cli, packages or engine (above)"; }
  echo "warning: the candidate includes uncommitted changes:" >&2
  echo "$dirty" >&2
fi

# The engine must be built from this checkout's engine/ (scripts/lib/engine-fresh.sh); a prebuilt engine names the
# engine/ tree it was built from instead.
[ -d "$framework_src" ] || die "no NNCore framework at $framework_src (engine/nncore/apply.sh, then build chrome_framework)"
[ "$phase" = sign ] || [[ " $(lipo -archs "$framework_src/Versions/Current/Chromium Framework" 2>/dev/null) " == *" arm64 "* ]] \
  || die "the NNCore framework at $framework_src has no arm64 slice"
if [ "$phase" = sign ]; then
  [ -n "$provisioning_profile" ] || die "--phase sign exports the ad hoc archive --phase build made: set RELEASE_PROVISIONING_PROFILE"
elif [ -n "$framework_engine" ]; then
  [ -n "${NNCORE_FRAMEWORK:-}" ] || die "NNCORE_FRAMEWORK_ENGINE names the engine tree a prebuilt NNCORE_FRAMEWORK was built from; set both or neither"
  [ "$framework_engine" = "$(git -C "$root" rev-parse HEAD:engine)" ] \
    || die "NNCORE_FRAMEWORK_ENGINE is $framework_engine but HEAD's engine tree is $(git -C "$root" rev-parse HEAD:engine): that framework wasn't built from this commit's engine"
elif [ -z "${NNCORE_FRAMEWORK:-}" ]; then
  "$root/scripts/lib/engine-fresh.sh" "$framework_src" "$chromium_src" || exit 1
fi

identity_name="Developer ID Application"
notarize=0
if [ "$phase" != build ]; then
  identity="$(security find-identity -v -p codesigning | awk -v n="$identity_name" 'index($0, n) { print $2; exit }')"
  [ -n "$identity" ] || die "no $identity_name identity"
  if [ -n "$sparkle_key_file" ]; then
    [ -s "$sparkle_key_file" ] || die "SPARKLE_KEY_FILE ($sparkle_key_file) is missing or empty"
  else
    "$sparkle/generate_keys" --account "$sparkle_account" -p >/dev/null 2>&1 \
      || die "no Sparkle EdDSA key in the login keychain under account $sparkle_account (SPARKLE_ACCOUNT)"
  fi
  if xcrun notarytool history "${notary_auth[@]}" >/dev/null 2>&1; then
    notarize=1
  elif [ "${ALLOW_UNNOTARIZED:-0}" = 1 ]; then
    echo "warning: no notarytool credentials; the build won't be notarized" >&2
  else
    # Releases are notarized since 0.2.1: an unnotarized one makes every new user go through System Settings › Open
    # Anyway again. Store the credentials or set ALLOW_UNNOTARIZED=1.
    echo "error: notarytool credentials are missing or invalid (scripts/.notary.env or the '$notary_profile' profile):" >&2
    xcrun notarytool history "${notary_auth[@]}" 2>&1 | head -2 >&2
    exit 1
  fi
fi

cli_tarball="$dist/bay-cli-$version-macos-arm64.tar.gz"
build_cli() {
  echo "==> bay CLI"
  "$root/apps/cli/scripts/build.sh" "$version" "$dist" >"$dist/cli-build.log" 2>&1 \
    || { tail -20 "$dist/cli-build.log" >&2; die "building the bay CLI failed ($dist/cli-build.log)"; }
}

if [ "$phase" != sign ]; then
  rm -rf "$dist"
  mkdir -p "$dist"
  {
    echo "version $version, build $release_build, $channel${version_settings:+ (${version_settings[*]})}"
    echo "commit $(git -C "$root" rev-parse HEAD)${dirty:+ + uncommitted changes}"
    echo "framework $(plutil -extract SCMRevision raw "$framework_src/Versions/Current/Resources/Info.plist" 2>/dev/null)"
    echo "framework built $(stat -f '%Sm' "$framework_src/Versions/Current/Chromium Framework")${framework_engine:+ (prebuilt, engine tree $framework_engine)}"
  } >"$dist/provenance.txt"

  build_cli

  echo "==> Content blocker"
  # The pinned uBlock Origin, which embed.sh copies into the app.
  "$nncore/scripts/ubo.sh"
  [ -f "$nncore/vendor/ubo/ext/manifest.json" ] || die "uBlock Origin isn't installed ($nncore/scripts/ubo.sh)"

  # Without the team's development profile (CI, or an export by hand), the archive is signed ad hoc and the export
  # signs it for real.
  if [ -n "$provisioning_profile" ] || [ "$phase" = build ]; then
    archive_signing=(-xcconfig macos/AdHoc.xcconfig)
  else
    archive_signing=(-allowProvisioningUpdates)
  fi
  echo "==> Archive"
  # The engine is staged into this build's own folder, so a development build restaging its copy can't change a
  # release mid-build. The pod lock too: a pod install rewriting Pods.xcodeproj under the archive breaks it.
  (cd "$app_dir" && NNCORE_FRAMEWORK="$framework_src" "$root/scripts/agent/locked" pod --wait 1800 -- \
    "$root/scripts/agent/locked" xcodebuild --wait 1800 -- xcodebuild -workspace macos/Bay.xcworkspace -scheme Bay-macOS \
    -configuration Release -destination 'generic/platform=macOS' ARCHS=arm64 NNCORE_STAGE_DIR="$build/NNCoreFramework" \
    ${version_settings[@]+"${version_settings[@]}"} BAY_UPDATE_CHANNEL="$channel" BAY_CLI_SHA256_FILE="$cli_tarball.sha256" \
    ${extra_build_settings[@]+"${extra_build_settings[@]}"} \
    -derivedDataPath "$build" -archivePath "$archive" "${archive_signing[@]}" archive) \
    >"$dist/archive.log" 2>&1 || {
    # (Pods' old deployment targets print as errors too, but don't fail the build.)
    grep -E "error:|build commands failed" -A2 "$dist/archive.log" | grep -v MACOSX_DEPLOYMENT_TARGET | tail -20 >&2
    die "archive failed ($dist/archive.log)"
  }
fi
if [ "$phase" = sign ] && [ -n "$build_input" ]; then
  rm -rf "$dist"
  mkdir -p "$dist"
  [ -f "$build_input/provenance.txt" ] && [ ! -L "$build_input/provenance.txt" ] || die "no provenance.txt in $build_input"
  cp "$build_input/provenance.txt" "$dist/provenance.txt"
  for asset in "bay-cli-$version-macos-arm64.tar.gz" "bay-cli-$version-macos-arm64.tar.gz.sha256"; do
    [ -f "$build_input/$asset" ] && [ ! -L "$build_input/$asset" ] || die "no $asset in $build_input"
    cp "$build_input/$asset" "$dist/$asset"
  done

fi

[ -f "$cli_tarball" ] && [ -f "$cli_tarball.sha256" ] || die "the CLI release is missing from $dist"
cli_expected="$(awk -v name="$(basename "$cli_tarball")" 'NR == 1 && NF == 2 && $2 == name { print $1 }' "$cli_tarball.sha256")"
[[ "$cli_expected" =~ ^[0-9a-f]{64}$ ]] || die "the CLI checksum file is invalid"
cli_actual="$(shasum -a 256 "$cli_tarball" | awk '{ print $1 }')"
[ "$cli_actual" = "$cli_expected" ] || die "the CLI archive checksum doesn't match"
cmp "$cli_tarball.sha256" "$archive/Products/Applications/Bay.app/Contents/Resources/bay-cli.sha256" \
  || die "the archived app pins a different CLI checksum"

if [ "$phase" = build ]; then
  echo
  echo "Built $archive (signed ad hoc); sign it with --phase sign."
  exit 0
fi

sign() {
  local attempt
  for attempt in 1 2 3 4 5; do
    codesign --force --timestamp --sign "$identity" "$@" && return 0
    echo "    signing failed (attempt $attempt), likely no timestamp from Apple; retrying" >&2
    sleep 5
  done
  die "couldn't sign ${*: -1}"
}
if [ -n "$provisioning_profile" ]; then
  echo "==> Export (Developer ID, $(basename "$provisioning_profile"))"
  "$root/scripts/lib/export-developer-id.sh" "$archive/Products/Applications/Bay.app" "$app" "$provisioning_profile" \
    "$macos/Bay-macOS/Bay.entitlements" "$identity" "$bundle_id" >"$dist/export.log" 2>&1 || { cat "$dist/export.log" >&2; exit 1; }
else
  echo "==> Export (Developer ID)"
  # Apple's timestamp server sometimes doesn't answer ("A timestamp was expected but was not found"); one miss among
  # the dozens of pieces the export signs fails it, so retry that, and only that, a few times.
  for attempt in 1 2 3 4 5 6; do
    rm -rf "$dist/export"
    xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$macos/ExportOptions-DeveloperID.plist" \
      -exportPath "$dist/export" -allowProvisioningUpdates >"$dist/export.log" 2>&1 && break
    grep -q "A timestamp was expected" "$dist/export.log" && [ "$attempt" -lt 6 ] \
      || { cat "$dist/export.log" >&2; exit 1; }
    echo "    no timestamp from Apple (attempt $attempt), exporting again"
    sleep 10
  done
fi

echo "==> Sign Chrome's framework"
# The export signs what it knows: the app (with the Developer ID profile its keychain groups need), Sparkle,
# hermes. Chrome's framework and its helpers are signed as Chrome signs them, inside out: the helpers under the
# hardened runtime, the renderer and GPU ones (Aperitif's too) with their JIT entitlements and without library
# validation (incompatible with JIT), then the framework, then the app again with what the export gave it.
entitlements_dir="$nncore/scripts/signing"
fw="$app/Contents/Frameworks/Chromium Framework.framework"
fwv="$(cd "$fw/Versions/Current" && pwd -P)" || die "no Chromium Framework.framework in the export"
echo "==> Strip Chromium's local symbols"
# Keep the exact unstripped binaries for crash analysis, outside the shipped app. Only the private export changes.
symbols="$dist/symbols/Chromium Framework.framework"
mkdir -p "$(dirname "$symbols")"
cp -cR "$fw" "$symbols"
while IFS= read -r -d '' binary; do
  [[ "$(file -b "$binary")" == *Mach-O* ]] || continue
  relative="${binary#"$fw"/}"
  original="$symbols/$relative"
  dwarfdump --uuid "$original" | awk '{ print $1, $2, $3 }' >"$dist/uuid-before.txt"
  nm -gjU "$original" | LC_ALL=C sort >"$dist/exports-before.txt"
  strip -x "$binary"
  dwarfdump --uuid "$binary" | awk '{ print $1, $2, $3 }' >"$dist/uuid-after.txt"
  nm -gjU "$binary" | LC_ALL=C sort >"$dist/exports-after.txt"
  cmp -s "$dist/uuid-before.txt" "$dist/uuid-after.txt" || die "stripping changed UUIDs: $relative"
  cmp -s "$dist/exports-before.txt" "$dist/exports-after.txt" || die "stripping changed exports: $relative"
  printf '%s: %s -> %s bytes; UUIDs and exports unchanged\n' "$relative" \
    "$(stat -f %z "$original")" "$(stat -f %z "$binary")" | tee -a "$dist/strip.log"
done < <(find "$fwv" -type f -print0)
rm "$dist/uuid-before.txt" "$dist/uuid-after.txt" "$dist/exports-before.txt" "$dist/exports-after.txt"
for lib in "$fwv"/Libraries/*.dylib; do sign "$lib"; done
for helper in "$fwv"/Helpers/*.app; do
  case "$(basename "$helper")" in
    *"Renderer).app") sign --options restrict,kill,runtime --entitlements "$entitlements_dir/renderer.entitlements" "$helper" ;;
    *"GPU).app") sign --options restrict,kill,runtime --entitlements "$entitlements_dir/gpu.entitlements" "$helper" ;;
    *) sign --options restrict,library,kill,runtime "$helper" ;;
  esac
done
sign --options restrict,library,kill,runtime "$fwv/Helpers/chrome_crashpad_handler"
sign --options restrict,library,kill,runtime "$fwv/Helpers/app_mode_loader"
[ -e "$fwv/Helpers/web_app_shortcut_copier" ] && sign --options restrict,library,kill,runtime \
  --identifier "$bundle_id.web_app_shortcut_copier" "$fwv/Helpers/web_app_shortcut_copier"
sign "$fw"
# An export by hand signed hermes with what the ad hoc archive gave it; Xcode's export signs it itself.
[ -n "$provisioning_profile" ] && [ -d "$app/Contents/Frameworks/hermes.framework" ] \
  && sign --preserve-metadata=identifier,entitlements,flags,runtime "$app/Contents/Frameworks/hermes.framework"
sign --preserve-metadata=entitlements,requirements,flags,runtime "$app"

echo "==> Verify"
codesign --verify --deep --strict "$app"
# Crash reports from users can only be symbolicated with the archive's dSYM (0.1.0/0.1.1 had none).
[ -d "$archive/dSYMs/Bay.app.dSYM" ] || die "the archive has no Bay.app.dSYM"
entitlements() { codesign -d --entitlements - --xml "$1" 2>/dev/null; }
info() { plutil -extract "$1" raw "$app/Contents/Info.plist" 2>/dev/null; }
# What an in-place update from an earlier copy depends on: the same bundle id and executable (Sparkle), the
# designated requirement (the keychain's Safe Storage item, TCC's grants), the feed and the update key.
[ "$(info CFBundleIdentifier)" = "$bundle_id" ] || die "bundle id is $(info CFBundleIdentifier)"
[ "$(info CFBundleExecutable)" = Bay ] || die "executable is $(info CFBundleExecutable)"
[ "$(info CFBundleShortVersionString)" = "$version" ] || die "CFBundleShortVersionString is $(info CFBundleShortVersionString)"
[ "$(info CFBundleVersion)" = "$release_build" ] || die "CFBundleVersion is $(info CFBundleVersion), not $release_build"
[ "$(info BayUpdateChannel)" = "$channel" ] || die "BayUpdateChannel is '$(info BayUpdateChannel)', not $channel"
[ "$(lipo -archs "$app/Contents/MacOS/Bay")" = arm64 ] || die "the app's executable is $(lipo -archs "$app/Contents/MacOS/Bay"), not arm64"
for key in SUFeedURL SUPublicEDKey NSDockTilePlugIn NSCameraUsageDescription NSMicrophoneUsageDescription \
  NSBluetoothAlwaysUsageDescription NSLocationUsageDescription NSLocalNetworkUsageDescription; do
  [ -n "$(info "$key")" ] || die "Info.plist has no $key"
done
[ -d "$app/Contents/Frameworks/Sparkle.framework" ] || die "no Sparkle.framework"
[ -d "$app/Contents/PlugIns/BayDockTile.plugin" ] || die "no dock tile plug-in"
[ -f "$app/Contents/embedded.provisionprofile" ] || die "no Developer ID provisioning profile (keychain groups need it)"
[ -f "$app/Contents/Resources/Extensions/ublock/manifest.json" ] || die "no uBlock Origin in the app"
designated="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
[[ "$designated" == *"identifier \"$bundle_id\""* && "$designated" == *"subject.OU] = $team"* ]] \
  || die "designated requirement: $designated"
app_ents="$(entitlements "$app")"
for group in webauthn unexportable-keys secure-payment-confirmation; do
  [[ "$app_ents" == *"$team.$bundle_id.$group"* ]] || die "the app lacks the keychain group …$group"
done
# Apple hasn't granted the managed passkey capability (Bay-ICloudPasskeys.entitlements).
[[ "$app_ents" != *web-browser.public-key-credential* ]] || die "the app is signed with com.apple.developer.web-browser.public-key-credential"
for helper in "$fwv"/Helpers/*"Renderer).app" "$fwv"/Helpers/*"GPU).app"; do
  [[ "$(entitlements "$helper")" == *cs.allow-jit* ]] || die "$(basename "$helper") lost allow-jit"
done
# Every piece of code: Developer ID, our team, a timestamp, the hardened runtime, no debugging entitlement.
while IFS= read -r -d '' code; do
  details="$(codesign -dvv "$code" 2>&1)"
  [[ "$details" == *"TeamIdentifier=$team"* && "$details" == *"Authority=Developer ID Application"* \
    && "$details" == *"Timestamp="* ]] || die "$code isn't Developer ID-signed with a timestamp"
  [[ "$(entitlements "$code")" != *get-task-allow* ]] || die "$code has get-task-allow"
done < <(find "$app" \( -name "*.app" -o -name "*.framework" -o -name "*.dylib" -o -name "*.xpc" -o -name "*.plugin" \
  -o -path "*/Helpers/*" -type f -perm -u+x -o -path "*/MacOS/*" -type f \) -print0)

# In CI the launch check runs on its own (--phase check), once the keys are gone.
[ "$phase" = sign ] || launch_check

notarize_file() {
  echo "Notarizing $(basename "$1")"
  xcrun notarytool submit "$1" "${notary_auth[@]}" --wait --timeout 1h | tee "$dist/notary-$(basename "$1").log"
  grep -q "status: Accepted" "$dist/notary-$(basename "$1").log" || die "notarization failed"
}
if [ "$notarize" = 1 ]; then
  echo "==> Notarize app"
  ditto -c -k --keepParent "$app" "$dist/notarize.zip"
  notarize_file "$dist/notarize.zip"
  rm "$dist/notarize.zip"
  xcrun stapler staple "$app"
fi

echo "==> Package"
ditto -c -k --keepParent "$app" "$zip"
staging="$dist/dmg"
mkdir -p "$staging/.background"
ditto "$app" "$staging/Bay.app"
ln -s /Applications "$staging/Applications"
# The window's look: its background and Finder's layout of it (scripts/release/dmg).
cp "$root/scripts/release/dmg/background.tiff" "$staging/.background/"
cp "$root/scripts/release/dmg/DS_Store" "$staging/.DS_Store"
hdiutil create -volname Bay -srcfolder "$staging" -format ULMO -imagekey udif-chunk-size=8192 -ov "$dmg" >/dev/null
rm -rf "$staging"
sign "$dmg"
if [ "$notarize" = 1 ]; then
  notarize_file "$dmg"
  xcrun stapler staple "$dmg"
fi

echo "==> Release notes"
# GitHub: the notes, then how to install and how it updates.
if [ "$notarize" = 1 ]; then
  install_line="Apple Silicon, macOS 14 or later. Signed with Developer ID and notarized by Apple: download, drag it to Applications, open it."
else
  install_line="Apple Silicon, macOS 14 or later. Signed with Developer ID but not notarized: on first launch macOS refuses to open it. Click Done, then System Settings › Privacy & Security › Open Anyway. Or run \`xattr -dr com.apple.quarantine /Applications/Bay.app\`."
fi
if [ "$channel" = nightly ]; then
  updates_line="A nightly: each day's changes, tested less than a stable release. It updates to newer nightlies and stable releases (Bay › Check for Updates…); Settings › General › Update channel switches back to Stable, which never downgrades."
else
  updates_line="Earlier versions update automatically (Bay › Check for Updates…). Every release's notes: $notes_page"
fi
{
  notes_body
  cat <<EOF

## Install

$install_line

$updates_line
EOF
} >"$dist/release-notes.md"

echo "==> Appcast"
# generate_appcast updates the published feed with this release's item (keeping 3 per channel); a nightly's is on
# Sparkle's nightly channel, which stable copies skip.
updates="$dist/updates"
mkdir -p "$updates"
cp "$zip" "$updates/"
# Next to the archive, generate_appcast embeds it in the item: Sparkle's update dialog shows it (Markdown).
{ printf '**%s**\n\n' "$headline"; notes_body; } >"$updates/Bay-$version.md"
[ -s "$base_feed" ] && cp "$base_feed" "$updates/appcast.xml"
if [ -n "$sparkle_key_file" ]; then
  key="$sparkle_key_file"
else
  # Only generate_keys (which created or imported the key) may read it without a keychain prompt, so hand
  # generate_appcast an exported copy.
  key_dir="$(mktemp -d)"
  cleanup+=("$key_dir")
  key="$key_dir/sparkle-key"
  "$sparkle/generate_keys" --account "$sparkle_account" -x "$key" >/dev/null
fi
channel_args=()
[ "$channel" = nightly ] && channel_args=(--channel nightly)
# --full-release-notes-url: "You're up to date" › Version History (packages/shell/ios/Updater.swift).
"$sparkle/generate_appcast" --ed-key-file "$key" ${channel_args[@]+"${channel_args[@]}"} \
  --download-url-prefix "https://github.com/$repo/releases/download/v$version/" \
  --embed-release-notes --full-release-notes-url "$notes_page" \
  --link "https://github.com/$repo" -o "$updates/appcast.xml" "$updates"
mv "$updates/appcast.xml" "$dist/appcast.xml"
grep -q "<sparkle:shortVersionString>$version<" "$dist/appcast.xml" || die "appcast.xml has no item for $version"
rm -rf "$updates"

echo
[ "$notarize" = 1 ] && echo "Notarized and stapled." || echo "NOT notarized."
[ "$rc" = 1 ] && echo "Release candidate: never publish dist/$version-rc."
[ "$rc" = 0 ] && echo "Publish it with scripts/release/publish.sh $version."
[ "$phase" = sign ] && echo "Not launched yet: remove the signing keys, then run the launch check (--phase check)."
du -sh "$app" "$dmg" "$zip" "$dist/appcast.xml" "$dist/release-notes.md"
