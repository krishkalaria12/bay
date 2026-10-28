#!/usr/bin/env bash
# A nightly's notes (Markdown, to stdout): what changed in the app since the previous release, nightly or stable, from
# the commit subjects. feat, fix and perf commits are listed; the rest is counted.
#
#   scripts/release/nightly-notes.sh [<since tag>]
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
since="${1:-$(git -C "$root" describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null || true)}"
range="${since:+$since..}HEAD"
subjects="$(git -C "$root" log --no-merges --format='%s' "$range" -- apps/browser packages engine)"

section() {
  local title="$1" type="$2" lines
  lines="$(grep -E "^$type(\([^)]*\))?!?: " <<<"$subjects" | sed -E 's/^[a-z]+(\(([^)]*)\))?!?: (.*)$/- \3 (\2)/; s/ \(\)$//' || true)"
  [ -n "$lines" ] || return 0
  printf '## %s\n\n%s\n\n' "$title" "$(awk '{ print toupper(substr($0, 1, 3)) substr($0, 4) }' <<<"$lines")"
}

listed="$(grep -cE '^(feat|fix|perf)(\([^)]*\))?!?: ' <<<"$subjects" || true)"
total="$(grep -c . <<<"$subjects" || true)"
echo "A nightly build of Bay, made from \`$(git -C "$root" rev-parse --short HEAD)\`${since:+, with what changed since $since}."
echo
section New feat
section Fixed fix
section Faster perf
other=$((total - listed))
if [ "$total" = 0 ]; then
  echo "No changes to the app since $since."
elif [ "$other" -gt 0 ]; then
  echo "And $other other change$([ "$other" = 1 ] || echo s) (refactors, tests, tooling)."
fi
