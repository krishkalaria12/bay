#!/usr/bin/env bash
# Puts the code every Bay engine shares into the tree: engine/shared/src mirrors paths under chromium/src, and each
# directory in `owned` is ours alone, so it is copied with --delete. Today that is //bay/filter, the content
# blocker's request and cookie filters, which desktop's //bay/core and Android's //bay/mobile both build on
# (scripts/android/engine.py copies the same directory into Android's tree). Idempotent; never touches args.gn.
#
# The convention, shared with engine/chromium and engine/nncore: engine/<layer>/src mirrors the tree,
# engine/<layer>/apply.sh copies it in (`--check` exits 1 when the tree differs), and the repo copy is the only one
# to edit.
#
#   engine/shared/apply.sh            copy
#   engine/shared/apply.sh --check    exit 1 if the tree differs from the repo
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}
owned=(bay/filter)

for dir in "${owned[@]}"; do
  if [[ "${1:-}" == --check ]]; then
    diff -r "$here/src/$dir" "$src/$dir" >/dev/null || { echo "drift: $dir" >&2; exit 1; }
  else
    mkdir -p "$src/$dir"
    # Not -t: a copied file gets the time of the copy, so ninja always sees it as new.
    rsync -rlp --delete --checksum "$here/src/$dir/" "$src/$dir/"
  fi
done
