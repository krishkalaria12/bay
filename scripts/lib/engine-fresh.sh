#!/usr/bin/env bash
# Checks that a Chromium Framework was built from this checkout's own Chromium code, NNCore's (engine/nncore) and the
# services it calls (engine/chromium): each apply.sh puts its copy in the tree and gives a changed file a new mtime, so
# a framework older than the tree's copy is stale. (The patches in engine/patches aren't checked here: they change only
# at a rebuild.)
#
#   scripts/lib/engine-fresh.sh <Chromium Framework.framework> <chromium src>
set -euo pipefail

usage="usage: scripts/lib/engine-fresh.sh <Chromium Framework.framework> <chromium src>"
framework_src="${1:?$usage}"
chromium_src="${2:?$usage}"
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
die() { echo "error: $*" >&2; exit 1; }

for layer in nncore chromium; do
  "$root/engine/$layer/apply.sh" --check \
    || die "the Chromium tree differs from engine/$layer: run engine/$layer/apply.sh and rebuild chrome_framework"
done
newest="$(find "$chromium_src/bay" "$chromium_src/chrome/browser/bay" -type f \
  -newer "$framework_src/Versions/Current/Chromium Framework" -print -quit)"
[ -z "$newest" ] || die "$newest is newer than the framework: rebuild chrome_framework"
