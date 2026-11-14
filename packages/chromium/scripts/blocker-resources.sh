#!/usr/bin/env bash
# Convert uBO's pinned, verified release resources into adblock-rust's Resource JSON. Only the resulting resources,
# license and provenance are bundled; no extension is installed or executed in the app.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# macOS has shasum; Git Bash on Windows (scripts/windows/web-artifacts.py) has sha256sum instead.
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
vendor=$(cd "$here/.." && pwd)/vendor
out="$vendor/blocker-resources"
version=1.75.0
sha=393cf95709d1074d4022970e9014e434395c53a822387f1e25f43be97cf4b582
stamp="$version-$sha-$(cat "$0" "$here/blocker-resources.mjs" | sha256 | cut -d ' ' -f 1)"
if [ -f "$out/.version" ] && [ "$(cat "$out/.version")" = "$stamp" ] && [ -s "$out/blocker-resources.json" ] && [ -s "$out/LICENSE.txt" ]; then exit 0; fi
mkdir -p "$vendor"
tmp=$(mktemp -d "$vendor/.blocker-resources.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
archive="$vendor/ubo/uBlock0_$version.chromium.zip"
if [ ! -f "$archive" ]; then
  archive="$tmp/ubo.zip"
  curl -fsSL --retry 3 --max-time 120 -o "$archive" "https://github.com/gorhill/uBlock/releases/download/$version/uBlock0_$version.chromium.zip"
fi
echo "$sha  $archive" | sha256 -c - >&2
unzip -q "$archive" -d "$tmp"
source="$tmp/uBlock0.chromium"
# Keep these build-time ES modules independent of the repository's package type.
printf '{"type":"module"}\n' > "$source/package.json"
node "$here/blocker-resources.mjs" "$source" "$tmp/blocker-resources.json"
mkdir -p "$out"
cp "$source/LICENSE.txt" "$out/LICENSE.txt"
printf 'uBlock Origin %s\nSource: https://github.com/gorhill/uBlock/releases/tag/%s\nArchive SHA-256: %s\n' "$version" "$version" "$sha" > "$out/SOURCE.txt"
mv "$tmp/blocker-resources.json" "$out/blocker-resources.json"
printf '%s\n' "$stamp" > "$out/.version"
