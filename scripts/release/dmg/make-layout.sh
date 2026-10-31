#!/usr/bin/env bash
# Writes DS_Store, the DMG window's layout: a 660 × 440 icon view on background.tiff, no toolbar, Bay.app and
# Applications 128 pt at (170, 284) and (490, 284). Finder lays it out on a scratch volume named Bay, the release DMG's
# name, which the background's alias points into; scripts/release.sh copies it in as .DS_Store with no Finder needed.
set -euo pipefail
cd "$(dirname "$0")"
tmp=$(mktemp -d)
mnt="$tmp/mnt"
trap 'hdiutil detach -quiet "$mnt" 2>/dev/null || true; rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src/.background" "$tmp/src/Bay.app"
cp background.tiff "$tmp/src/.background/"
ln -s /Applications "$tmp/src/Applications"
hdiutil create -quiet -volname Bay -srcfolder "$tmp/src" -format UDRW -fs HFS+ "$tmp/scratch.dmg"
hdiutil attach -quiet -nobrowse -noautoopen -mountpoint "$mnt" "$tmp/scratch.dmg"
osascript - "$mnt" <<'APPLESCRIPT'
on run argv
  set volumePath to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    open volumePath
    set w to container window of volumePath
    set current view of w to icon view
    set toolbar visible of w to false
    set statusbar visible of w to false
    -- The bounds take in the title bar (32 pt on macOS 26), so the background shows whole under it.
    set bounds of w to {200, 120, 860, 592}
    set o to icon view options of w
    set arrangement of o to not arranged
    set icon size of o to 128
    set text size of o to 13
    set shows item info of o to false
    set shows icon preview of o to true
    set background picture of o to file ".background:background.tiff" of volumePath
    set position of item "Bay.app" of w to {170, 284}
    set position of item "Applications" of w to {490, 284}
    update volumePath without registering applications
    delay 1
    close w
  end tell
end run
APPLESCRIPT
for _ in $(seq 20); do [ -s "$mnt/.DS_Store" ] && break; sleep 0.5; done
sleep 2
cp "$mnt/.DS_Store" DS_Store
