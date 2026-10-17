# Windows implementation checkpoint

Updated 17 October 2026. Windows 10 and Windows 11 x64 are supported targets.
Mica requires Windows 11 build 22621 or later. macOS keeps its existing native
host. The `ios` directories contain macOS sources, not mobile application targets.

The [port plan](windows-port-plan.html) uses react-native-web inside
`chrome://bay`, a Mojo native bridge, and SurfaceEmbed page elements. The Windows
build now targets Chrome with Bay's NNCore layer. The port is still in progress;
no Windows Chromium build or native hosting acceptance run has passed yet.

## Implemented and checked on macOS

- The shared UI boots in a localhost web preview with React 19,
  react-native-web and the real Reanimated web implementation. Production web
  export, desktop and web TypeScript checks, and JavaScript tests pass.
- Native calls use an asynchronous transport with versioned JSON envelopes,
  generated method validation, native events and startup snapshots. Document
  writes serialize per document and roll back the local cache on failure.
- Web view adapters cover desktop keys, hover, focus, menus, drag regions,
  Fluent glyphs and CSS effects. Mobile platform policy and the former React
  Native for Windows host have been removed.
- Portable import tests cover Chromium, Firefox, Arc, HTML, CSV, sessions,
  committed SQLite WAL data, source preservation and cancellation. Windows
  secret readers use DPAPI and Firefox NSS. App-bound secrets return export
  guidance rather than attempting to bypass their protection.
- Portable sync tests match Swift CryptoKit golden envelopes, reject tampering
  and cross-profile ciphertext, and cover recovery phrases and vault storage.
  Recovery QR codes and PDF output have been decoded independently on macOS.
- Windows pipeline tests cover pinned revisions, patch selection, archive
  validation, locks, manifests and staging. Packaging stages the Chrome runtime,
  exported UI and generated Mojo JavaScript. Update policy and installer checks
  are implemented; their native application integration remains pending.
- The macOS production JavaScript bundle still builds.

The former React Native for Windows implementation is recoverable from commit
`f9e87f27`. Its portable import and sync services remain in this branch.

## Chrome host work in progress

The initial native host sources provide the `chrome://bay` resource loader,
Mojo bridge, generated contracts, direct engine dispatch and SurfaceEmbed tab
mounting. The patch applies after the Windows export patch against copies of the
pinned Chromium source. This is source-level verification, not a native build.

A dedicated hosting test page provides two page elements, a translucent blurred
overlay, a Reanimated animation, frame-interval sampling, bridge timing, an IME
input and native page controls. In the localhost preview it displays explicit
placeholders instead of substituting iframes or claiming native results.

The host still needs complete OS module coverage, shared state across windows,
profile/private-tab ownership, tab transfer, browser events and the remaining
native page methods. Portable NNCore extraction and import/sync linkage are
being implemented. Do not treat the diagnostic page as a complete browser host.

## Validation still required on Windows

Build the pinned Chrome target and run the hosting gate before accepting the
architecture. Record compositor transparency and clipping, focus and keyboard
routing, DPI changes, IME, accessibility, video, fullscreen, PiP, DevTools,
independent profiles, private browsing and tab transfer. Measure the actual Mojo
bridge and animation behavior. Window liveness alone does not pass this gate.

Installer, signatures, updater rollback, default-browser registration, import
from installed browsers and recovery-kit output also require Windows tests.

## Commands

On macOS:

```sh
pnpm web
# Open the localhost URL with ?spike=1 for the hosting test page,
# or ?onboarding=1 to exercise the full onboarding flow.
pnpm build:web
pnpm typecheck
pnpm typecheck:web
pnpm test
pnpm test:windows-build
pnpm test:windows-native
node packages/platform/scripts/native-contracts.mjs --check
python3 scripts/windows/generate-engine-calls.py --check
```

Portable native tests require C++17, `pkg-config` and OpenSSL on macOS. They
fetch a checksum-pinned nlohmann/json header into a temporary dependency cache.
Windows tests use MSVC, CNG and the Windows SQLite API.

On the Windows engine machine, use the Visual Studio, ATL/MFC and Windows SDK
versions required by the pinned Chromium revision, a short NTFS checkout path,
and enough space for the complete Chromium source and build output.

```powershell
python scripts/windows/engine.py all --root C:\bay-engine --output C:\bay-artifacts
# Stage the matching engine artifact through scripts/windows/build-app.py.
pwsh -File scripts/windows/smoke.ps1 -AppPath C:\bay-app\Bay.exe -HostingSpike
```

`smoke.ps1` checks process and window liveness. Complete the manual hosting gate
on the visible diagnostic page separately.
