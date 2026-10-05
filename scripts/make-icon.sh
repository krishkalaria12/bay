#!/bin/bash
#
# Rebuild Bay's icon PNGs from the SVG sources:
#
#   scripts/make-icon.sh
#
# The sources are apps/browser/assets/app-icon.svg, the full mark, and
# app-icon-small.svg, a heavier cut of the same mark for 16-32px where the
# hangers and braces turn to mush. Each renders through headless Chrome at 1024
# and downsamples with Lanczos, which is what the checked-in PNGs came from.
#
# Needs Google Chrome to render and ImageMagick to scale. Writes only under
# apps/browser/.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
assets="$root/apps/browser/assets"
set_dir="$root/apps/browser/macos/Bay-macOS/Assets.xcassets/AppIcon.appiconset"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

command -v magick >/dev/null || { echo "magick not found (brew install imagemagick)" >&2; exit 1; }
[ -x "$chrome" ] || { echo "no Chrome at $chrome" >&2; exit 1; }

render() {
  # render <svg> <size> <out.png>
  "$chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --screenshot="$tmp/render.png" --window-size="$2,$2" \
    --default-background-color=00000000 "file://$assets/$1" >/dev/null 2>&1
  magick "$tmp/render.png" -resize "$2x$2!" -strip "$3"
}

echo "rendering the sources at 1024"
render app-icon.svg 1024 "$tmp/full.png"
render app-icon-small.svg 1024 "$tmp/small.png"

# size <source> <output name>
emit() {
  magick "$1" -filter Lanczos -resize "$2x$2" "$3"
}

echo "the in-app asset (used by the onboarding, the check-in banner and the task manager)"
emit "$tmp/full.png" 1254 "$assets/app-icon.png"

echo "the macOS icon set"
emit "$tmp/small.png" 16  "$set_dir/icon_16x16_1x.png"
emit "$tmp/small.png" 32  "$set_dir/icon_16x16_2x.png"
emit "$tmp/small.png" 32  "$set_dir/icon_32x32_1x.png"
emit "$tmp/small.png" 64  "$set_dir/icon_32x32_2x.png"
emit "$tmp/full.png"  128 "$set_dir/icon_128x128_1x.png"
emit "$tmp/full.png"  256 "$set_dir/icon_128x128_2x.png"
emit "$tmp/full.png"  256 "$set_dir/icon_256x256_1x.png"
emit "$tmp/full.png"  512 "$set_dir/icon_256x256_2x.png"
emit "$tmp/full.png"  512 "$set_dir/icon_512x512_1x.png"
emit "$tmp/full.png"  1024 "$set_dir/icon_512x512_2x.png"

echo "done: $assets/app-icon.png and 10 files in $(basename "$set_dir")"
