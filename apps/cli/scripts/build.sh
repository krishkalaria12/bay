#!/bin/bash
# Builds the bay CLI: a standalone compiled executable using Bun.
#
#   apps/cli/scripts/build.sh [version] [out dir]
#
set -euo pipefail

cli_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$cli_dir"

version="${1:-0.1.0}"
out_dir="${2:-$cli_dir/dist}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$ ]] || { echo "invalid CLI version: $version" >&2; exit 1; }

mkdir -p "$out_dir"
out_dir=$(cd "$out_dir" && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/bay-cli-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT

bun install --frozen-lockfile

bun build --compile ./bin/bay.ts \
  --target=bun-darwin-arm64 \
  --define BAY_CLI_VERSION="\"$version\"" \
  --outfile "$out_dir/bay"

package="bay-cli-$version"
mkdir -p "$stage/$package/bin"
install -m 0755 "$out_dir/bay" "$stage/$package/bin/bay"
archive="$package-macos-arm64.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$out_dir/$archive" -C "$stage" "$package"
(cd "$out_dir" && shasum -a 256 "$archive" >"$archive.sha256")

echo "Built $out_dir/bay and $out_dir/$archive (version $version)"
