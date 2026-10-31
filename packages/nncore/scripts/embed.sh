#!/bin/bash
# Xcode build phase (apps/browser/macos): clones the staged NNCore framework (stage-framework.sh) into
# the app bundle. An APFS clone: instant, whatever its 500 MB.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
staged=${NNCORE_STAGE_DIR:-$repo/apps/browser/build-nncore/NNCoreFramework}/"Chromium Framework.framework"
frameworks="$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH"
mkdir -p "$frameworks"
stamp="$DERIVED_FILE_DIR/nncore-embedded.stamp"
mkdir -p "$DERIVED_FILE_DIR"
# The staged copy is signed ad hoc. A build signed with a team identity (Apple Development) signs it again with that
# identity, under the hardened runtime, as Chrome signs its own helpers (the renderer and GPU ones with JIT):
# library validation rejects an ad-hoc framework in a team-signed app. A release re-signs it with Developer ID.
identity="${EXPANDED_CODE_SIGN_IDENTITY:--}"
[ -z "$identity" ] && identity="-"
# Signing this script or its entitlements differently re-signs too.
want="$(cat "$staged/../.stamp") $identity $(cat "$0" "$here"/signing/*.entitlements | shasum -a 256 | cut -c1-16)"
if ! [[ -f "$stamp" && "$(cat "$stamp")" == "$want" && -d "$frameworks/Chromium Framework.framework" ]]; then
  rm -rf "$frameworks/Chromium Framework.framework"
  cp -cR "$staged" "$frameworks/"
  if [ "$identity" != "-" ]; then
    sign() { codesign --force --timestamp=none --sign "$identity" "$@"; }
    fwv=$(cd "$frameworks/Chromium Framework.framework/Versions/Current" && pwd -P)
    for lib in "$fwv"/Libraries/*.dylib; do sign "$lib"; done
    for helper in "$fwv"/Helpers/*.app; do
      case "$(basename "$helper")" in
        *"Renderer).app") sign --options runtime --entitlements "$here/signing/renderer.entitlements" "$helper" ;;
        *"GPU).app") sign --options runtime --entitlements "$here/signing/gpu.entitlements" "$helper" ;;
        *) sign --options runtime "$helper" ;;
      esac
    done
    for tool in chrome_crashpad_handler app_mode_loader web_app_shortcut_copier; do
      [ -e "$fwv/Helpers/$tool" ] && sign --options runtime "$fwv/Helpers/$tool"
    done
    sign "$frameworks/Chromium Framework.framework"
  fi
  echo "$want" > "$stamp"
fi

# The content blocker's default filter lists (filter-lists.sh, which downloads them once and keeps them fresh) →
# Resources/FilterLists, so a new install blocks from its first page. uBlock Origin, which the app once bundled under
# Resources/Extensions, goes.
"$here/filter-lists.sh"
lists="$repo/packages/nncore/vendor/filter-lists"
if [ -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}" ]; then
  resources="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
  rm -rf "$resources/Extensions"
  mkdir -p "$resources/FilterLists"
  rsync -a --delete --include '*.txt' --exclude '*' "$lists/" "$resources/FilterLists/"
fi
