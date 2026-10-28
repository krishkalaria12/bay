#!/usr/bin/env bash
# Publishes what scripts/release.sh built in dist/<version> (or RELEASE_DIST):
#
#   scripts/release/publish.sh <version> [--dry-run]
#
# Both channels share one feed, appcast.xml on the latest stable release (SUFeedURL, bay.krishkalaria.in/appcast.xml,
# redirects there). The release's item goes onto the feed as published right now, so a nightly that shipped while
# this was building isn't dropped, keeping the newest 3 items per channel.
#   stable   v<version>, latest, with Bay-<version>.dmg, Bay.dmg (the site's /download), the zip and the merged feed.
#   nightly  v<version>, a prerelease (so latest, the feed's home and /download stay on stable), with the DMG and zip;
#            the merged feed replaces the latest stable release's; Bay-Nightly.dmg on the prerelease "nightly"
#            (bay.krishkalaria.in/nightly) becomes this one; nightlies beyond the newest 5 are deleted with their tags.
# The tag is v<version> at the commit provenance.txt names: an existing tag must point there, a missing one is
# created there. --dry-run checks and prints everything and publishes nothing.
set -euo pipefail

usage="usage: scripts/release/publish.sh <version> [--dry-run]"
version="${1:?$usage}"
dry=0
case "${2:-}" in
  "") ;;
  --dry-run) dry=1 ;;
  *) echo "$usage" >&2; exit 1 ;;
esac
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
repo="krishkalaria12/bay"
dist="${RELEASE_DIST:-$root/dist/$version}"
keep_nightlies=5
die() { echo "error: $*" >&2; exit 1; }
run() {
  printf '+'; printf ' %q' "$@"; echo
  [ "$dry" = 1 ] || "$@"
}

if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+$ ]]; then
  channel=nightly
elif [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  channel=stable
else
  die "$version is neither a stable (<major>.<minor>.<patch>) nor a nightly (<next stable>-nightly.<n>) version"
fi
dmg="$dist/Bay-$version.dmg"
zip="$dist/Bay-$version.zip"
feed="$dist/appcast.xml"
notes="$dist/release-notes.md"
for file in "$dmg" "$zip" "$feed" "$notes" "$dist/provenance.txt"; do
  [ -f "$file" ] || die "no $file (scripts/release.sh $version --channel $channel first)"
done
provenance_commit="$(sed -n 's/^commit \([0-9a-f]\{40\}\)$/\1/p' "$dist/provenance.txt")"
[ -n "$provenance_commit" ] || die "$dist/provenance.txt names no clean commit (a build with uncommitted changes is never published)"
item="$(awk -v v="$version" '/<item>/ { buf = "" } { buf = buf $0 "\n" } /<\/item>/ && buf ~ ("shortVersionString>" v "<") { print buf; exit }' "$feed")"
[ -n "$item" ] || die "$feed has no item for $version"
if [ "$channel" = nightly ]; then
  grep -q '<sparkle:channel>nightly</sparkle:channel>' <<<"$item" || die "$version's item in $feed isn't on the nightly channel"
else
  ! grep -q '<sparkle:channel>' <<<"$item" || die "$version's item in $feed is on a channel, so stable copies would skip it"
fi
gh release view "v$version" -R "$repo" >/dev/null 2>&1 && die "v$version is already published"

remote_tag="$(git ls-remote "https://github.com/$repo.git" "refs/tags/v$version^{}" "refs/tags/v$version" | awk '{ print $1 }' | head -1)"
if [ -n "$remote_tag" ]; then
  [ "$remote_tag" = "$provenance_commit" ] || die "v$version on GitHub is $remote_tag, but the build is of $provenance_commit"
  tag_args=(--verify-tag)
else
  echo "note: v$version isn't on GitHub yet: the release creates it at $provenance_commit"
  tag_args=(--target "$provenance_commit")
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/nn-publish.XXXXXX")"
trap 'rm -rf "$work"' EXIT
stable_tag="$(gh release view -R "$repo" --json tagName -q .tagName)"
[[ "$stable_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the latest release is $stable_tag, not a stable one: the feed lives on the latest stable release"
if gh release view "$stable_tag" -R "$repo" --json assets -q '.assets[].name' | grep -qx appcast.xml; then
  gh release download "$stable_tag" -R "$repo" -p appcast.xml -D "$work"
  live="$work/appcast.xml"
else
  echo "note: $stable_tag has no appcast.xml yet: $version starts it"
  live=none
fi

echo "==> Feed"
mkdir -p "$work/out"
merged="$work/out/appcast.xml"
python3 -I - "$live" "$feed" "$version" "$merged" <<'PY'
import re, subprocess, sys
live_path, built_path, version, out_path = sys.argv[1:]
item_pattern = re.compile(r"[ \t]*<item>.*?</item>\n?", re.S)
def build_of(item):
    found = re.search(r"<sparkle:version>([^<]+)</sparkle:version>", item)
    return found.group(1) if found else None
def channel_of(item):
    found = re.search(r"<sparkle:channel>([^<]+)</sparkle:channel>", item)
    return found.group(1) if found else "stable"
def newest_first(builds):
    out = subprocess.run(["sort", "-V", "-r"], input="\n".join(builds) + "\n", capture_output=True, text=True, check=True).stdout
    return [b for b in out.splitlines() if b]
built = open(built_path).read()
mine = [i for i in item_pattern.findall(built) if f"<sparkle:shortVersionString>{version}<" in i]
if len(mine) != 1:
    sys.exit(f"error: {built_path} has {len(mine)} items for {version}")
item = mine[0]
build = build_of(item)
if live_path == "none":
    live, live_items = built, item_pattern.findall(built)
else:
    live = open(live_path).read()
    if "xmlns:sparkle" not in live or "<channel>" not in live:
        sys.exit(f"error: {live_path} isn't a Sparkle appcast")
    live_items = item_pattern.findall(live)
if any(build_of(i) == build for i in live_items if f"<sparkle:shortVersionString>{version}<" not in i):
    sys.exit(f"error: the published feed already has build {build} as another version")
others = [i for i in live_items if build_of(i) != build]
newest = newest_first([build_of(i) for i in others] + [build])[0]
if others and newest != build:
    sys.exit(f"error: {version} is build {build}, but the published feed already has build {newest}: copies would never be offered it")
# The newest 3 per channel, newest first.
order = newest_first([build_of(i) for i in [item] + others])
items, counts = [], {}
for b in order:
    i = item if b == build else next(o for o in others if build_of(o) == b)
    c = channel_of(i)
    if counts.get(c, 0) < 3:
        counts[c] = counts.get(c, 0) + 1
        items.append("        " + i.strip() + "\n")
start = live.index("<item>") if live_items else live.index("</channel>")
head = re.sub(r"[ \t]*$", "", live[:start])
tail = live[live.rindex("</item>") + len("</item>"):].lstrip("\n") if live_items else "    </channel>\n</rss>\n"
open(out_path, "w").write(head + "".join(items) + "    " + tail.lstrip(" \t"))
summary = ", ".join(f"{n} {c}" for c, n in sorted(counts.items()))
print(f"PASS  {version} (build {build}, {channel_of(item)}) is above every build in the published feed; it lists {summary}")
PY
python3 -I -c 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])' "$merged" || die "the merged feed isn't well-formed XML"
if [ "$channel" = stable ]; then
  latest="${stable_tag#v}"
  [ "$version" != "$latest" ] && [ "$(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -1)" = "$version" ] \
    || die "$version isn't above the latest stable release ($latest): publishing it as latest would move every download and the feed backward"
  echo "PASS  $version is above the latest stable release ($latest)"
fi

echo "==> Release"
if [ "$channel" = stable ]; then
  cp -c "$dmg" "$work/out/Bay.dmg"
  run gh release create "v$version" -R "$repo" --latest "${tag_args[@]}" --title "Bay $version" \
    --notes-file "$notes" "$dmg" "$work/out/Bay.dmg" "$zip" "$merged"
else
  run gh release create "v$version" -R "$repo" --prerelease --latest=false "${tag_args[@]}" --title "Bay $version" \
    --notes-file "$notes" "$dmg" "$zip"
  # The feed's home stays the latest stable release.
  run gh release upload "$stable_tag" -R "$repo" --clobber "$merged"
  nightly_notes="The newest nightly, always as Bay-Nightly.dmg (https://bay.krishkalaria.in/nightly). Now $version: https://github.com/$repo/releases/tag/v$version. Nightlies update themselves to the next one; Settings › General › Update channel switches a copy between Stable and Nightly."
  if [ "$dry" = 1 ] || ! gh release view nightly -R "$repo" >/dev/null 2>&1; then
    run gh release create nightly -R "$repo" --prerelease --latest=false --target "$provenance_commit" --title "Bay Nightly" --notes "$nightly_notes"
  fi
  cp -c "$dmg" "$work/out/Bay-Nightly.dmg"
  run gh release upload nightly -R "$repo" --clobber "$work/out/Bay-Nightly.dmg"
  run gh release edit nightly -R "$repo" --notes "$nightly_notes"

  # Older nightlies: the feed lists at most 3, so the 5 newest cover every item a copy can be offered.
  old="$(gh release list -R "$repo" --limit 200 --json tagName -q '.[].tagName' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+$' | grep -vx "v$version" | sort -V -r | tail -n +"$keep_nightlies" || true)"
  for tag in $old; do
    grep -q "releases/download/$tag/" "$merged" && continue
    run gh release delete "$tag" -R "$repo" --yes --cleanup-tag
  done
fi

[ "$dry" = 1 ] && { echo "dry run: nothing published"; exit 0; }
echo "==> Check"
status=0
for url in "https://github.com/$repo/releases/latest/download/appcast.xml" "https://bay.krishkalaria.in/appcast.xml"; do
  for _ in $(seq 1 18); do
    xml="$(curl -fsSL --max-time 20 "$url" 2>/dev/null || true)"
    grep -q "<sparkle:shortVersionString>$version<" <<<"$xml" && break
    sleep 10
  done
  grep -q "<sparkle:shortVersionString>$version<" <<<"$xml" && echo "PASS  $url lists $version" \
    || { echo "FAIL  $url lists $version"; status=1; }
done
if [ "$channel" = nightly ]; then
  url="https://github.com/$repo/releases/download/nightly/Bay-Nightly.dmg"
  size="$(curl -fsSLI --max-time 30 "$url" | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')"
  [ "$size" = "$(stat -f %z "$dmg")" ] && echo "PASS  $url is $version's DMG" \
    || { echo "FAIL  $url is $version's DMG (size $size, expected $(stat -f %z "$dmg"))"; status=1; }
fi
exit $status
