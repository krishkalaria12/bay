# Build Bay locally

Run these commands from this repository. JavaScript dependencies, CocoaPods and
Xcode's Metal toolchain are already installed on this Mac. The engine sources have
been downloaded. Full engine compilation and app packaging remain unverified.

## Download the engine sources

```bash
cd "/Users/krish/Desktop/Coding/Desktop apps/bay"
scripts/download-engine
```

This downloads the pinned CEF/Chromium 154.0.8037.58 source and dependencies into
`~/chromium-build`. It does not compile the engine. Existing tooling and ungoogled
checkouts are reused. An interrupted initial Git fetch must restart; the helper
preserves its incomplete directory before retrying. Once an engine build exists,
use the incremental build command below rather than rerunning the downloader.

## Compile the engine

```bash
export NN_REPO="$PWD"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer

scripts/agent/locked chromium -- bash -c '
  set -e
  bash "$HOME/chromium-build/scripts/02-cef-patch-and-gen.sh"
  python3 "$HOME/chromium-build/scripts/03-ungoogled.py"
  bash "$HOME/chromium-build/scripts/04-domain-substitution.sh"
  "$NN_REPO/scripts/agent/engine-build" -- -j 4 chrome_framework
'
```

Run this preparation sequence once on the downloaded tree. The first compilation
takes hours. Four jobs limit memory use on this Mac's 16 GB of RAM. Netnyahoo's
documented configuration used about 43 GB for the completed source/build tree.

For subsequent engine builds:

```bash
scripts/agent/engine-build -- -j 4 chrome_framework
```

## Build the app

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
XCODE_XCCONFIG_FILE="$PWD/apps/browser/macos/AdHoc.xcconfig" \
scripts/agent/build-app --config Release --force
```

The output is `apps/browser/build-dev/Build/Products/Release/Bay.app`. This is a
local ad hoc build with its JavaScript bundled, so Metro is not needed. The signing
configuration omits restricted keychain entitlements, including Chrome-profile
passkeys. Security-key and phone passkeys remain available.

## Checks

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
pnpm typecheck
pnpm test
pnpm shaders:check
```

All these checks, native pod compilation and Release JavaScript bundling passed
before cancellation. Full engine compilation and final app packaging remain
unverified.
