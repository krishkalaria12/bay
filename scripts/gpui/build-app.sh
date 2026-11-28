#!/bin/bash
# Builds the GPUI app (packages/rust/bay-app) into a macOS app bundle:
#
#   <out>/Bay GPUI.app/Contents/{MacOS/bay, Frameworks/Chromium Framework.framework, Resources/…, Info.plist}
#
# The framework is the staged NNCore one (packages/chromium/scripts/stage-framework.sh; NNCORE_FRAMEWORK names
# another), cloned into the bundle (APFS clone, no new disk). The bundle is signed ad hoc, so it runs only with a
# scratch data folder: BAY_DATA_DIR=<folder> "<out>/Bay GPUI.app/Contents/MacOS/bay". A spike build: its own bundle
# id (in.krishkalaria.bay.gpui), never the installed Bay's data. docs/gpui-desktop-plan.html, Phase 0.
#
#   scripts/gpui/build-app.sh [--release] [--out <dir>]     (default out: packages/rust/target/gpui)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
workspace="$repo/packages/rust"
profile=dev
out="$workspace/target/gpui"
while (($#)); do
  case "$1" in
    --release) profile=app ;;
    --out) out=$2; shift ;;
    *) echo "build-app: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

# rustup's toolchain (packages/rust/rust-toolchain.toml) ahead of any system Rust on PATH.
export PATH="$HOME/.cargo/bin:$PATH"

framework=${NNCORE_FRAMEWORK:-$repo/apps/browser/build-nncore/NNCoreFramework/Chromium Framework.framework}
if [[ -z "${NNCORE_FRAMEWORK:-}" ]]; then
  NNCORE_STAGE_DIR="$repo/apps/browser/build-nncore/NNCoreFramework" "$repo/packages/chromium/scripts/stage-framework.sh"
fi
[[ -x "$framework/Chromium Framework" ]] || { echo "build-app: no NNCore framework at $framework" >&2; exit 1; }
export NNCORE_FRAMEWORK="$framework"

(cd "$workspace" && cargo build -p bay-app --profile "$profile")
target_dir=$([[ $profile == dev ]] && echo debug || echo "$profile")
binary="$workspace/target/$target_dir/bay"

app="$out/Bay GPUI.app"
contents="$app/Contents"
rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Frameworks" "$contents/Resources"
cp "$binary" "$contents/MacOS/bay"
cp -cR "$framework" "$contents/Frameworks/" 2>/dev/null || cp -R "$framework" "$contents/Frameworks/"

version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$workspace/bay-app/Cargo.toml" | head -1)
build=$(git -C "$repo" rev-list --count HEAD 2>/dev/null || echo 1)
sed -e "s/@VERSION@/$version/" -e "s/@BUILD@/$build/" "$workspace/bay-app/resources/Info.plist" >"$contents/Info.plist"
plutil -lint "$contents/Info.plist" >/dev/null
printf 'APPL????' >"$contents/PkgInfo"

# What the host glue reads from the bundle: the page script and the content blocker's lists and resources.
glue="$repo/packages/chromium/ios"
cp "$glue/page_script.js" "$glue/filter_lists.json" "$contents/Resources/"
"$repo/packages/chromium/scripts/filter-lists.sh"
"$repo/packages/chromium/scripts/blocker-resources.sh"
mkdir -p "$contents/Resources/FilterLists" "$contents/Resources/ContentBlocker"
rsync -a --include '*.txt' --exclude '*' "$repo/packages/chromium/vendor/filter-lists/" "$contents/Resources/FilterLists/"
rsync -a "$repo/packages/chromium/vendor/blocker-resources/" "$contents/Resources/ContentBlocker/"

codesign --force --sign - "$contents/MacOS/bay"
codesign --force --sign - "$app"
echo "$app"
