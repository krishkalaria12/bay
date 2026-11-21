#!/bin/bash
#
# Rebuild every PNG of Bay's icons from the SVG sources:
#
#   scripts/make-icon.sh
#
# Sources, all in apps/browser/assets/:
#   app-icon.svg        Dusk in Paper, the default icon everywhere (64px up and in the app's own UI)
#   app-icon-small.svg  the same mark cut heavier for 16-32px, where three thin lines blur together
#   app-icons/*.svg     the other icons people can pick in Settings › Appearance (Navy, Coral, Noir,
#                       Cobalt and Bridge, Bay's first icon)
#   new-tab-bay.svg     the mark in one colour, for tabs with no page yet
#
# Each renders through headless Chrome at 1024 and downsamples with Lanczos. The phone apps'
# icons (apps/ios, apps/android) and the web's touch icon are drawn full-bleed (the squircle clip
# and edge come off; the OS masks them). The Bridge's phone PNGs are kept as they were drawn for
# the first launch and aren't rebuilt.
#
# Needs Google Chrome to render and ImageMagick to scale.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
assets="$root/apps/browser/assets"
catalog="$root/apps/browser/macos/Bay-macOS/Assets.xcassets"
set_dir="$catalog/AppIcon.appiconset"
web="$root/apps/web"
ios="$root/apps/ios/Bay/Resources"
xcassets="$ios/Assets.xcassets"
res="$root/apps/android/app/src/main/res"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

command -v magick >/dev/null || { echo "magick not found (brew install imagemagick)" >&2; exit 1; }
[ -x "$chrome" ] || { echo "no Chrome at $chrome" >&2; exit 1; }

# The alternates: file name, and the name the apps show and use as the icon's id.
alternates=(
  "navy Navy"
  "coral Coral"
  "noir Noir"
  "cobalt Cobalt"
  "bridge Bridge"
)

render() {
  # render <svg path> <out.png>, at 1024
  "$chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --screenshot="$tmp/render.png" --window-size=1024,1024 \
    --default-background-color=00000000 "file://$1" >/dev/null 2>&1
  magick "$tmp/render.png" -resize "1024x1024!" -strip "$2"
}

full_bleed() {
  # full_bleed <svg> <out.svg>: no squircle clip, no edge
  sed -e 's| clip-path="url(#squircle)"||' -e '/id="edge"/d' "$1" > "$2"
}

# size <source png> <size> <out>
emit() {
  magick "$1" -filter Lanczos -resize "$2x$2" -strip "$3"
}

adaptive() {
  # adaptive <svg> <out.svg>: full-bleed, the mark shrunk into Android's adaptive safe zone (the
  # middle 66 of 108dp) and centred on its own middle (the sun and lines sit at y 320-858).
  full_bleed "$1" "$tmp/bleed.svg"
  sed -e 's|<rect width="1024" height="1024" fill="url(#sky)"/>|&<g transform="translate(512 512) scale(.85) translate(-512 -589)">|' \
    -e 's|^  </g>$|  </g></g>|' "$tmp/bleed.svg" > "$2"
}

# opaque <source png> <size> <out>: for icons that mustn't carry an alpha channel (iOS)
opaque() {
  magick "$1" -filter Lanczos -resize "$2x$2" -background white -alpha remove -alpha off -strip "$3"
}

echo "rendering the sources at 1024"
render "$assets/app-icon.svg" "$tmp/full.png"
render "$assets/app-icon-small.svg" "$tmp/small.png"
render "$assets/new-tab-bay.svg" "$tmp/new-tab.png"
full_bleed "$assets/app-icon.svg" "$tmp/bleed.svg" && render "$tmp/bleed.svg" "$tmp/bleed.png"
adaptive "$assets/app-icon.svg" "$tmp/adaptive.svg" && render "$tmp/adaptive.svg" "$tmp/adaptive.png"

echo "desktop: the in-app asset (onboarding, the check-in banner, the task manager) and the new-tab mark"
emit "$tmp/full.png" 1254 "$assets/app-icon.png"
emit "$tmp/new-tab.png" 16 "$assets/new-tab-bay.png"
emit "$tmp/new-tab.png" 32 "$assets/new-tab-bay@2x.png"
emit "$tmp/new-tab.png" 48 "$assets/new-tab-bay@3x.png"

echo "desktop: the macOS icon set"
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

echo "web: favicons, touch icon, manifest icon and the site's logo (SVG, so it stays sharp)"
cp "$assets/app-icon-small.svg" "$web/public/favicon.svg"
for size in 16 32 48; do emit "$tmp/small.png" "$size" "$tmp/favicon-$size.png"; done
magick "$tmp/favicon-16.png" "$tmp/favicon-32.png" "$tmp/favicon-48.png" "$web/public/favicon.ico"
opaque "$tmp/bleed.png" 180 "$web/public/apple-touch-icon.png"
emit "$tmp/full.png" 512 "$web/public/icon-512.png"
cp "$assets/app-icon.svg" "$web/src/assets/app-icon.svg"

echo "videos: the icon in the release videos' intros"
cp "$assets/app-icon.png" "$root/apps/videos/public/app-icon.png"

# phone <bleed png> <adaptive png> <Name> <file>: one icon in both phone apps. iOS gets the
# full-bleed icon (the default in AppIcon, an alternate in <Name>.appiconset); Android gets the
# adaptive foreground at each density, over the colour in res/values/colors.xml (minSdk 29 always
# draws the adaptive icon). Both get the 192px preview Settings › Appearance shows.
phone() {
  local set="AppIcon" image="App-Icon-1024x1024@1x.png" foreground="ic_launcher_foreground"
  if [ "$3" != Paper ]; then set="$3" image="$4-1024.png" foreground="ic_launcher_foreground_$4"; fi
  opaque "$1" 1024 "$xcassets/$set.appiconset/$image"
  opaque "$1" 192 "$xcassets/AppIconPreviews/$3.imageset/$3.png"
  opaque "$1" 192 "$res/drawable-nodpi/app_icon_$4.png"
  local density size
  for density in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
    size=${density#*:}
    opaque "$2" "$size" "$res/mipmap-${density%:*}/$foreground.png"
  done
}

echo "phones: the app icon, its Android foreground and the welcome's mark"
phone "$tmp/bleed.png" "$tmp/adaptive.png" Paper paper
emit "$tmp/full.png" 512 "$ios/bay-mark.png"
emit "$tmp/full.png" 512 "$res/drawable-nodpi/bay_mark.png"

for entry in "${alternates[@]}"; do
  read -r file name <<<"$entry"
  echo "alternate: $name"
  render "$assets/app-icons/$file.svg" "$tmp/$file.png"
  # The desktop picks it up by name from the asset catalog (AppIcon<Name>), in the app and in
  # the Dock tile plug-in.
  imageset="$catalog/AppIcon$name.imageset"
  mkdir -p "$imageset"
  emit "$tmp/$file.png" 512 "$imageset/$file.png"
  emit "$tmp/$file.png" 1024 "$imageset/$file@2x.png"
  cat > "$imageset/Contents.json" <<JSON
{
  "images" : [
    { "filename" : "$file.png", "idiom" : "universal", "scale" : "1x" },
    { "filename" : "$file@2x.png", "idiom" : "universal", "scale" : "2x" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
  [ "$file" = bridge ] && continue
  full_bleed "$assets/app-icons/$file.svg" "$tmp/alt-bleed.svg" && render "$tmp/alt-bleed.svg" "$tmp/alt-bleed.png"
  adaptive "$assets/app-icons/$file.svg" "$tmp/alt-adaptive.svg" && render "$tmp/alt-adaptive.svg" "$tmp/alt-adaptive.png"
  phone "$tmp/alt-bleed.png" "$tmp/alt-adaptive.png" "$name" "$file"
done

echo "done"
