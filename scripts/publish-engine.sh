#!/usr/bin/env bash
# Publishes this checkout's arm64 engine for CI releases, which can't build Chromium: packs the local Chromium
# Framework as built (unstripped: release.sh strips the app's copy, and this stays the symbols' copy), uploads it to
# the GitHub prerelease engine-<engine tree:12> (never latest, so the feed and the download links never move to it)
# and appends the tree's line to packages/nncore/prebuilt-engines.tsv. Run it after building an engine whose engine/
# changed, then commit and push that line: a release whose engine/ tree has no line fails its build at once.
#
#   scripts/publish-engine.sh [--dry-run] [<Chromium Framework.framework>]
#
# The framework defaults to $CHROMIUM_SRC/out/Release_GN_arm64 (~/chromium-build/chromium_git/chromium/src). It must
# be fresh (scripts/lib/engine-fresh.sh) and engine/ committed and pushed. --dry-run packs into dist/engine-<tree:12>
# and prints the gh commands and the table line, publishing nothing.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
repo="krishkalaria12/bay"
table="$root/packages/nncore/prebuilt-engines.tsv"
chromium_src="${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}"
die() { echo "error: $*" >&2; exit 1; }
dry=0 framework=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    -*) die "unknown option $1" ;;
    *) framework="$1" ;;
  esac
  shift
done
framework="${framework:-$chromium_src/out/Release_GN_arm64/Chromium Framework.framework}"
problem() { if [ "$dry" = 1 ]; then echo "warning: $*" >&2; else die "$*"; fi; }
run() {
  printf '+'; printf ' %q' "$@"; echo
  [ "$dry" = 1 ] || "$@"
}

[ -f "$framework/Versions/Current/Chromium Framework" ] || die "no Chromium Framework at $framework"
[[ " $(lipo -archs "$framework/Versions/Current/Chromium Framework") " == *" arm64 "* ]] || die "$framework has no arm64 slice"
tree="$(git -C "$root" rev-parse HEAD:engine)"
short="${tree:0:12}"
tag="engine-$short"
commit="$(git -C "$root" rev-parse HEAD)"
[ -z "$(git -C "$root" status --porcelain -- engine)" ] || problem "engine/ has uncommitted changes: the engine would be published under a tree it wasn't built from"
"$root/scripts/lib/engine-fresh.sh" "$framework" "$chromium_src" || problem "the framework isn't built from this checkout's engine/ (above)"
git -C "$root" fetch -q origin main || problem "couldn't fetch origin"
git -C "$root" merge-base --is-ancestor "$commit" origin/main || problem "HEAD ($commit) isn't on origin/main: push it first, the tag $tag points at it"
existing="$(awk -v t="$tree" '$1 == t { print $2; exit }' "$table" 2>/dev/null || true)"
[ -z "$existing" ] || problem "prebuilt-engines.tsv already lists this engine tree under $existing"

out="$root/dist/$tag"
rm -rf "$out" && mkdir -p "$out"
archive="$out/NNCore-$short.tar.xz"
echo "==> Pack"
# Under the chromium lock: an engine build writes there.
"$root/scripts/agent/locked" chromium --wait 500 -- \
  bash -c 'COPYFILE_DISABLE=1 tar --no-mac-metadata -cf - -C "$(dirname "$1")" "Chromium Framework.framework" | xz -T0 -9 >"$2"' \
  _ "$framework" "$archive"
sha="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
echo "$sha  $(basename "$archive")" >"$archive.sha256"
line="$(printf '%s\t%s\t%s' "$tree" "$tag" "$sha")"

echo "==> Publish"
notes="Bay's engine (NNCore's Chromium Framework, unstripped) for engine/ tree $tree (commit $commit), for release builds without a Chromium tree (packages/nncore/scripts/fetch-engine.sh). Not an app release."
if [ "$dry" = 1 ] || ! gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  run gh release create "$tag" -R "$repo" --prerelease --latest=false --target "$commit" --title "Engine $short" --notes "$notes"
fi
run gh release upload "$tag" -R "$repo" --clobber "$archive" "$archive.sha256"
if [ "$dry" = 1 ]; then
  echo "dry run: nothing published. The table line would be:"
  echo "$line"
else
  [ "$(gh release view "$tag" -R "$repo" --json isPrerelease -q .isPrerelease)" = true ] || die "$tag isn't a prerelease"
  printf '%s\n' "$line" >>"$table"
  echo "Published $tag. Commit and push packages/nncore/prebuilt-engines.tsv (appended: $line)."
fi
du -sh "$archive"
