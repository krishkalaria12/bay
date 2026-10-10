# Bay

A macOS browser built on Chrome's own framework: a patched Chromium tree with our layer on top
(NNCore), an Expo + React Native macOS shell, and Metal shaders for window backdrops and animations.

```
apps/
  browser/            Expo + react-native-macos app (UI in src/, Xcode project in macos/)
  web/                The website, Astro + React + Tailwind (its own pnpm workspace)
engine/
  chromium/           Our Chromium code: src/chrome/browser/bay, copied in by apply.sh
  nncore/             The layer: src/bay/core, plus the hooks that make Chrome's framework link it
  patches/            The patch series (series, series.py) and the source-build steps
packages/
  nncore/             JS API over the engine (tab strips, autofill, extensions, content blocker)
  shell/              Native menu bar + shortcuts → JS, windows, SF Symbols, native primitives
  shaders/            Metal animations + grained OKLab window backdrop
  import/             Import from other browsers (bookmarks, history, passwords, Arc spaces)
  sync/               Encrypted sync: sealed files in a folder, merged on a recovery phrase
  core/               Pure TS: omnibox input → URL, suggestions, breadcrumbs (tested)
```

## Run it

Requires Xcode 26+, CocoaPods, Node 22+, pnpm 11.

```bash
pnpm install
```

The engine needs a Chromium source tree in `~/chromium-build`. Copy our code in and build
Chrome's framework (the first build takes about two hours):

```bash
engine/chromium/apply.sh
engine/nncore/apply.sh
autoninja -C out/Release_GN_arm64 chrome_framework
```

`scripts/agent/engine-build` does those steps under the Chromium lock in one command. The app's
build stages the framework from there.

```bash
pnpm pods
```

In one terminal, start Metro:

```bash
pnpm dev
```

In another, build and launch the Debug app (on its own data,
`~/Library/Application Support/Bay Dev`, or `BAY_DATA_DIR`):

```bash
pnpm macos
```

Other tasks: `pnpm typecheck`, `pnpm test`, `pnpm lint` (oxlint), `pnpm fmt` / `pnpm fmt:check` (oxfmt),
`pnpm shaders:check` (compiles the embedded Metal offline), `pnpm build` (Release `.app` with a Hermes bytecode
bundle in `apps/browser/build/`). CI (`.github/workflows`) runs the same checks on every push and pull request.
`pnpm install` turns on the git hooks in `.githooks`: a commit formats its files with oxfmt, and a push stops if lint
or the format check fails.
Swift package tests need full Xcode for XCTest. The test runner uses `/Applications/Xcode.app`
if the selected Command Line Tools lack XCTest. Set `DEVELOPER_DIR` to use another Xcode installation;
the runner leaves the global `xcode-select` setting unchanged.
Signed releases (DMG, Sparkle zip and appcast): `scripts/release.sh <version>`, which reads its
notes from `release-notes/<version>.md`. That directory isn't in the repo yet, and the release script
points at `bay.com` for the notes page and update feed — set both to your own domain before
shipping.

Shortcuts: ⌘T new tab, ⌘L command bar, ⌘W close tab, ⇧⌘T reopen, ⌘S auto-hide tabs, ⇧⌘S tabs in
sidebar, ⌘[ / ⌘] back/forward, ⌘R reload (⇧⌘R force), ⌘1–⌘8 select tab, ⌃Tab tab switcher,
⌃⇧= split pane.

## Environment variables

Most are for tests and hidden instances rather than normal use.

| Variable | Effect |
|---|---|
| `BAY_DATA_DIR` | The app's data directory. A test instance gets its own, so it never touches your real profile |
| `BAY_BACKGROUND` | `1` launches without taking focus, for smoke tests |
| `BAY_REMOTE_DEBUGGING_PORT` | The port DevTools attaches to |
| `BAY_JS_LOCATION` | Metro URL the native side loads the bundle from |
| `BAY_RELEASE_NOTES` | `1` shows the after-update notes even when the version matches |
| `BAY_ALLOW_AUDIO`, `BAY_ALLOW_OCCLUSION` | Let a hidden instance play sound and be treated as occluded |
| `BAY_IMPORT_SOURCE_DIR`, `BAY_IMPORT_SAFARI_HOME`, `BAY_IMPORT_TEST_SECRET` | Point the importer at fixture folders and a test Safe Storage key instead of the real Keychain |

## Architecture notes

- **Why Expo SDK 54:** `react-native-macos` tops out at 0.81, which pairs with Expo SDK 54 (whose
  `ExpoAppDelegate` / `ExpoReactNativeFactory` have macOS code paths).
- **Legacy architecture.** react-native-macos 0.81's Fabric support is experimental, so the app runs
  on the legacy architecture. One consequence: Expo's legacy view-manager adapter instantiates a
  module's *first* view class for every view it declares, so each native view has its own module.
- **Metro, not `expo start`.** Metro runs through the react-native-macos CLI. `metro.config.js`
  redirects `react-native` → `react-native-macos` for `platform=macos`, because defining our own
  `resolveRequest` replaces the redirect the CLI would install.
- **No Reanimated.** It has no macOS build for 0.81; animations use RN's `Animated`.
- **Monorepo paths.** pnpm is set to `nodeLinker: hoisted` because CocoaPods and Metro resolve
  `react-native-macos` by path. The Podfile rewrites `REACT_NATIVE_PATH` to the hoisted location and
  raises every pod's deployment target to 14.0, since Xcode 26+ rejects the 11.0 some Expo pods
  declare.
- **Native subviews** are sized in `setFrameSize`, not `layout()`. RN macOS assigns frames directly and
  never autoresizes subviews.
- **Shaders** are Metal source embedded in Swift and compiled at runtime (once per class, cached).
  This keeps the pods free of a metallib build phase.
- **The engine is mirrored, not generated.** `engine/<layer>/src` mirrors paths in the Chromium tree
  and `apply.sh` copies it in; `--check` exits 1 when the tree drifts from the repo. The repo copy is
  the only one to edit.
- **Chrome's surfaces are ours.** Chrome-hosted windows, the tab strip as revisioned transactions, the
  context menu, PiP and the autofill dropdowns are Chrome's own views, driven from
  `engine/nncore/src/bay/core`.

## The icon

The Golden Gate's twin towers and catenary over the bay at dusk. Two sources, both in
`apps/browser/assets/`:

| File | What it's for |
|---|---|
| `app-icon.svg` | The full mark: hangers, two braces per tower, stars and ripples. Used from 64px up and in the app's own UI |
| `app-icon-small.svg` | The same mark cut heavier — no hangers, one brace, a deeper sag. The full mark turns to mush at 16-32px, which is the size the Finder uses |

`app-icon.png` is the rasterised full mark, used by the onboarding, the check-in banner and the
task manager. `macos/Bay-macOS/Assets.xcassets/AppIcon.appiconset/` is the macOS set: the small cut
for the 16 and 32 slots, the full mark from 128 up.

Rebuild every PNG from the sources:

```bash
scripts/make-icon.sh
```

It renders each SVG through headless Chrome at 1024 and downsamples with Lanczos, so it needs
Chrome and ImageMagick. The geometry in the SVGs is computed, not drawn by hand: the squircle is
`|x/a|⁵ + |y/a|⁵ = 1`, and the cable hangers sit on the same cubic béziers the cable is drawn from.

## License

Bay is licensed under the [Apache License 2.0](LICENSE). It builds on Chromium, the Chromium
Embedded Framework and ungoogled-chromium, and bundles uBlock Origin Lite, each under its own
license; see [NOTICE](NOTICE).
