#!/usr/bin/env bash
# Draws background.html at 1x and 2x with Chrome and joins them into background.tiff, the DMG window's background.
# Run it after changing background.html, then make-layout.sh if the window's size or the icons moved.
set -euo pipefail
cd "$(dirname "$0")"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for scale in 1 2; do
  "$chrome" --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor="$scale" \
    --window-size=660,440 --screenshot="$tmp/$scale.png" "file://$PWD/background.html" 2>/dev/null
done
tiffutil -cathidpicheck "$tmp/1.png" "$tmp/2.png" -out background.tiff
