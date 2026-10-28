#!/bin/bash
# Fetches the prebuilt engine for this checkout's engine/ tree (scripts/publish-engine.sh published it, and
# prebuilt-engines.tsv names its release and SHA-256) into apps/browser/build-nncore/prebuilt/<tree:12>, and prints the
# framework's path, for NNCORE_FRAMEWORK. CI's release build uses it; it fails when engine/ has no published engine.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
repo=krishkalaria12/bay
table="$here/../prebuilt-engines.tsv"
store="$root/apps/browser/build-nncore/prebuilt"
name="Chromium Framework"
die() { echo "error: $*" >&2; exit 1; }

[ -z "$(git -C "$root" status --porcelain -- engine)" ] \
  || die "engine/ has uncommitted changes, and no prebuilt has them: build the engine (BUILDING.md)"
tree=$(git -C "$root" rev-parse HEAD:engine)
entry=$(awk -v t="$tree" '$1 == t { print; exit }' "$table" 2>/dev/null || true)
[ -n "$entry" ] || die "no prebuilt engine for engine/ tree ${tree:0:12}: build it, run scripts/publish-engine.sh, and commit prebuilt-engines.tsv"
read -r tree tag sha <<<"$entry"
short=${tree:0:12}
dest="$store/$short"
if [ ! -f "$dest/.complete" ]; then
  file="NNCore-$short.tar.xz"
  url="https://github.com/$repo/releases/download/$tag/$file"
  tmp="$store/.tmp-$$"
  rm -rf "$tmp" && mkdir -p "$tmp"
  trap 'rm -rf "$tmp"' EXIT
  echo "downloading the engine ($url)" >&2
  curl -fL --retry 3 --progress-bar -o "$tmp/$file" "$url" || die "couldn't download $url"
  [ "$(shasum -a 256 "$tmp/$file" | awk '{ print $1 }')" = "$sha" ] || die "$file doesn't match its SHA-256 in prebuilt-engines.tsv"
  tar -xJf "$tmp/$file" -C "$tmp" || die "couldn't unpack $file"
  [ -f "$tmp/$name.framework/Versions/Current/$name" ] || die "$file holds no $name.framework"
  rm -f "$tmp/$file"
  touch "$tmp/.complete"
  rm -rf "$dest"
  mv "$tmp" "$dest"
  trap - EXIT
  for old in "$store"/*/; do
    [ "${old%/}" = "$dest" ] || rm -rf "${old%/}"
  done
fi
echo "$dest/$name.framework"
