#!/bin/sh
set -eu
source="$PROJECT_DIR/../../../apps/cli/install.sh"
resources="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
mkdir -p "$resources"
install -m 0644 "$source" "$resources/bay-cli-install.sh"
if [ -n "${BAY_CLI_SHA256_FILE:-}" ]; then
  install -m 0644 "$BAY_CLI_SHA256_FILE" "$resources/bay-cli.sha256"
else
  # A development build must not retain a checksum from a previous release build.
  rm -f "$resources/bay-cli.sha256"
fi
