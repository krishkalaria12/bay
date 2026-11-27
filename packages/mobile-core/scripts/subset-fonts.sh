#!/usr/bin/env bash
# Rebuilds design/fonts: the fonts pages can show in (browser/fonts.rs), from google/fonts, cut down to Latin, Latin
# Extended, Greek and Cyrillic as woff2. Literata and Inter keep their weight axis and are pinned to text size on the
# optical size axis, which halves them. Needs python3; fonttools and brotli go in a throwaway venv.
#
# Usage: packages/mobile-core/scripts/subset-fonts.sh
set -euo pipefail

out="$(cd "$(dirname "$0")/../design/fonts" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/src" "$work/pinned"

python3 -m venv "$work/venv"
"$work/venv/bin/pip" -q install fonttools brotli

base=https://raw.githubusercontent.com/google/fonts/main/ofl
fetch() { curl -sfL "$base/$1" -o "$work/src/$2"; }

# The ranges Google Fonts names latin, latin-ext, greek, greek-ext, cyrillic and cyrillic-ext.
ranges="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,\
U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD,U+0100-024F,U+0259,U+1E00-1EFF,\
U+2020,U+20A0-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF,U+0370-03FF,U+1F00-1FFF,U+0400-04FF,U+0500-052F,U+2116"

subset() {
  "$work/venv/bin/pyftsubset" "$1" --unicodes="$ranges" --layout-features='*' --flavor=woff2 \
    --no-hinting --desubroutinize --output-file="$out/$2"
}

# Pins the optical size axis, then cuts the font down.
pinned() {
  "$work/venv/bin/fonttools" varLib.instancer "$work/src/$1" "opsz=$3" -q -o "$work/pinned/$2.ttf"
  subset "$work/pinned/$2.ttf" "$2.woff2"
}

fetch 'literata/Literata%5Bopsz%2Cwght%5D.ttf' literata.ttf
fetch 'literata/Literata-Italic%5Bopsz%2Cwght%5D.ttf' literata-italic.ttf
fetch 'inter/Inter%5Bopsz%2Cwght%5D.ttf' inter.ttf
fetch 'inter/Inter-Italic%5Bopsz%2Cwght%5D.ttf' inter-italic.ttf
fetch 'nunito/Nunito%5Bwght%5D.ttf' nunito.ttf
fetch 'nunito/Nunito-Italic%5Bwght%5D.ttf' nunito-italic.ttf
fetch 'lora/Lora%5Bwght%5D.ttf' lora.ttf
fetch 'lora/Lora-Italic%5Bwght%5D.ttf' lora-italic.ttf
fetch charissil/CharisSIL-Regular.ttf charis.ttf
fetch charissil/CharisSIL-Bold.ttf charis-bold.ttf
fetch charissil/CharisSIL-Italic.ttf charis-italic.ttf
fetch charissil/CharisSIL-BoldItalic.ttf charis-bold-italic.ttf
for licence in literata inter nunito lora charissil; do
  curl -sfL "$base/$licence/OFL.txt" -o "$out/OFL-$licence.txt"
done

pinned literata.ttf literata 12
pinned literata-italic.ttf literata-italic 12
pinned inter.ttf inter 14
pinned inter-italic.ttf inter-italic 14
for name in nunito nunito-italic lora lora-italic charis charis-bold charis-italic charis-bold-italic; do
  subset "$work/src/$name.ttf" "$name.woff2"
done

du -sh "$out"
