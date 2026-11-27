#!/bin/bash
# Writes Bay.xcworkspace: builds the Rust core first, because the project lists the Swift API it generates.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
"$here/../../packages/mobile-core/scripts/build-ios.sh"
cd "$here" && tuist generate --no-open
