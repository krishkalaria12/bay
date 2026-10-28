#!/usr/bin/env bash
# Prints the next nightly's version: <latest stable release with the patch bumped>-nightly.<n>, n counting up from 1
# since that stable (from the v<next>-nightly.* tags on GitHub). release.sh gives it the build after the stable's.
#
#   scripts/release/next-nightly.sh            1.5.4-nightly.3
set -euo pipefail

repo="krishkalaria12/bay"
die() { echo "error: $*" >&2; exit 1; }
stable="$(gh release view -R "$repo" --json tagName -q .tagName)"
[[ "$stable" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "the latest release is $stable, not a stable one"
next="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
last="$(git ls-remote --tags "https://github.com/$repo.git" "refs/tags/v$next-nightly.*" \
  | sed -n 's|.*refs/tags/v[0-9.]*-nightly\.\([0-9]*\)$|\1|p' | sort -n | tail -1)"
echo "$next-nightly.$((${last:-0} + 1))"
