#!/usr/bin/env bash
# The filter lists the app bundles: the content blocker's default lists (filter_lists.json, those on by default for
# every language), downloaded into packages/chromium/vendor/filter-lists for embed.sh to copy into
# Resources/FilterLists. A new install blocks with them from its first page, offline too, and updates them from the
# network soon after (NNCoreContentBlocker.mm). A copy younger than FILTER_LISTS_MAX_AGE_DAYS (default 3) is kept;
# a list that can't be downloaded keeps its older copy.
#
#   packages/chromium/scripts/filter-lists.sh [--strict]   --strict: fail unless every default list is there (releases)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
nncore=$(cd "$here/.." && pwd)
dest="$nncore/vendor/filter-lists"
max_age_days=${FILTER_LISTS_MAX_AGE_DAYS:-3}
strict=""
[ "${1:-}" = --strict ] && strict=1
mkdir -p "$dest"

missing=0
while IFS=$'\t' read -r id urls; do
  file="$dest/$id.txt"
  if [ -s "$file" ] && [ -z "$(find "$file" -mtime +"$max_age_days" 2>/dev/null)" ]; then continue; fi
  got=""
  for url in $urls; do
    if curl -fsSL --retry 2 --max-time 120 -o "$file.part" "$url" && [ -s "$file.part" ] && [ "$(head -c 1 "$file.part")" != "<" ]; then
      mv "$file.part" "$file"
      got=1
      break
    fi
  done
  rm -f "$file.part"
  if [ -z "$got" ]; then
    if [ -s "$file" ]; then echo "warning: $id didn't download; bundling the copy from $(date -r "$file" +%F)" >&2
    else echo "warning: $id didn't download; the app downloads it at first launch" >&2; missing=$((missing + 1)); fi
  fi
done < <(python3 -I -c '
import json, sys
for l in json.load(open(sys.argv[1]))["lists"]:
    if l.get("defaultOn") and not l.get("lang"):
        print(l["id"] + "\t" + " ".join(l["urls"]))
' "$nncore/ios/filter_lists.json")

if [ -n "$strict" ] && [ "$missing" -gt 0 ]; then
  echo "error: $missing default filter lists are missing from $dest" >&2
  exit 1
fi
