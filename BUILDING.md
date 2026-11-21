# Building Bay

For the Linux branch, see [Building Bay on Linux](docs/linux-building.md).

How to build Bay from source on your own Mac: the engine (a patched Chromium), then the app on top of
it. Run every command from the root of your clone.

## What you need

- A Mac with Apple silicon, running macOS 14 or later
- Xcode 26 or later, installed at `/Applications/Xcode.app` (the Command Line Tools alone aren't enough)
- CocoaPods, Node 22+ and pnpm 11
- About 50 GB of free disk for the Chromium source and build, and 16 GB of RAM or more

Then install the JavaScript dependencies and the pods:

```bash
pnpm install
pnpm pods
```

`pnpm install` also turns on the repo's git hooks (`.githooks`).

## 1. Download the engine sources

```bash
scripts/download-engine
```

This downloads the pinned CEF/Chromium 154.0.8037.58 source and its tools into `~/chromium-build`. It
doesn't compile anything. If the first Git fetch is interrupted, run it again: the script keeps the
incomplete folder aside and starts over. Run it only once; after the first engine build, use the
incremental command in step 2.

## 2. Compile the engine

Prepare the downloaded tree and build Chrome's framework once:

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

The first build takes several hours. `-j 4` keeps memory use within 16 GB of RAM; with more memory, raise
it or leave it out.

After that, rebuild only what changed:

```bash
scripts/agent/engine-build -- -j 4 chrome_framework
```

`engine-build` copies the repo's engine code (`engine/chromium`, `engine/nncore`) into the Chromium tree
first. Edit those folders in the repo, never the copies under `~/chromium-build`.

## 3. Build and open the app

```bash
pnpm start
```

This builds the Release app with ad hoc signing and opens it on its own data,
`~/Library/Application Support/Bay Dev`, so it never touches your everyday profile. The app has its
JavaScript bundled, so it doesn't need Metro. It lands in `apps/browser/build-dev/Build/Products/Release/Bay.app`.

To build without opening it:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
XCODE_XCCONFIG_FILE="$PWD/apps/browser/macos/AdHoc.xcconfig" \
scripts/agent/build-app --config Release --force
```

Ad hoc signing works without an Apple Developer account. It leaves out the restricted keychain
entitlements, so passkeys saved in the Chrome profile (Touch ID) aren't available. Passkeys from your
phone or a security key still work. An ad hoc build opens only with `BAY_DATA_DIR` set (`pnpm start`
sets it): it can't read the real keychain key, so on your installed data it would drop your sign-ins.

## Develop with hot reload

```bash
pnpm dev:app
```

This starts Metro, builds the Debug app (skipped when only JavaScript changed) and opens it on its own
data, `~/Library/Application Support/Bay Dev`, so it never touches your everyday profile. Saved
JavaScript changes reload in the open app, and Ctrl-C stops Metro. After changing native code, quit the
Debug app and run it again.

## Checks

These are the checks CI runs on every push and pull request:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt:check
pnpm shaders:check
```

## Troubleshooting

- **"an engine build already exists"** from `scripts/download-engine`: the sources are already there.
  Use `scripts/agent/engine-build` instead.
- **The app build can't find `Chromium Framework.framework`:** the engine hasn't been built yet, or not
  at `~/chromium-build/chromium_git/chromium/src/out/Release_GN_arm64`. Run step 2.
- **XCTest is missing** when running the Swift tests: set `DEVELOPER_DIR` to a full Xcode, as above.
- **A pod or CocoaPods error after pulling:** run `pnpm install` and `pnpm pods` again.
