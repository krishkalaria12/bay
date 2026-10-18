# Windows implementation checkpoint

Updated 18 October 2026. Windows 10 and Windows 11 x64 are supported targets.
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
  writes and acknowledged saves serialize per document and roll back the local
  cache on failure. Final session saves await disk acknowledgement before quit;
  cancelling quit invalidates stale save callbacks and resumes persistence.
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
  exported UI and generated Mojo JavaScript. Signed update policy binds the
  updater script hash. Deferred workers carry authenticated code and frozen
  arguments, revalidate cached installers, and support cancellation markers.
- The macOS production JavaScript bundle still builds.

The former React Native for Windows implementation is recoverable from commit
`f9e87f27`. Its portable import and sync services remain in this branch.

## Chrome host and runtime progress

The native host sources provide the `chrome://bay` resource loader, Mojo bridge,
generated contracts, restricted engine dispatch and SurfaceEmbed tab mounting.
The Windows patches apply in order against copies of pinned Chromium sources.
Actual generated Mojo C++ and TypeScript bindings and portable host sources
pass syntax checks against that revision. This is source-level verification,
not a Windows build or link.

A dedicated hosting test page provides two page elements, a translucent blurred
overlay, a Reanimated animation, frame-interval sampling, bridge timing, an IME
input and native page controls. In the localhost preview it displays explicit
placeholders instead of substituting iframes or claiming native results.

The host now includes native window registration, isolated private-profile
lifetime, tab mount leases and transfer ownership, extension and Cast adapters,
atomic document storage, clipboard, file dialogs, system integration and Windows
credential storage. Parked pages rejoin Chrome's tab strips before application
quit so Chrome can run their beforeunload handlers. These paths still need
Windows build and runtime verification.

Portable NNCore sources and Chrome import/sync service targets are linked in
the build definitions. Profile routing refuses unknown unloaded profiles, and
native workers marshal engine replies back through the browser UI thread.

The shared application runtime has an isolated store factory, read-only window
clients and an ordered command authority with epoch, revision and duplicate
request checks. Its Mojo transport and coordinator runner publish state before
acknowledging mutations. Recovery retains accepted live and navigation state
without session hydration. Native privacy and command validators have 12
executed C++ tests on macOS, linked against the pinned Chromium libraries.

Behind `--bay-shared-runtime`, a browser-owned detached WebContents holds the
coordinator, authenticates document connections and retains accepted state for
bounded crash recovery. Native projections remove other windows' private data;
global engine, data and window events go to the coordinator. This experimental
mode deliberately stops before the legacy UI entry, which still owns global
services. The coordinator and visible UI entries are not wired together yet.
Additional application windows remain gated pending command migration,
sole-writer persistence and two-window tests. Live document IO now starts
explicitly instead of running when window UI imports its store.

Native updater and close-button shutdown preparation now participate in the
acknowledged final session save. Native page controls cover printing, saving,
screenshots, certificate details and media operations. Windows browser and
installer identities, executable names, associations and taskbar IDs now agree.
Remaining work includes shared service ownership, page fact routing, complete
native event/OS coverage and the Windows acceptance runs. The diagnostic page
does not establish a complete browser host.

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
use the vendored, checksum-pinned nlohmann/json header without a network fetch.
Windows tests use MSVC, CNG and the Windows SQLite API.

With PowerShell installed, run the platform-independent updater contract tests:

```sh
pwsh -NoProfile -File scripts/windows/test-updater.ps1
```

These tests cover policy and payload rejection, encoded worker arguments,
staged-cache recovery and cancellation. Windows signature APIs, file locking,
process launching and actual installer execution require Windows validation.

On the Windows engine machine, use the Visual Studio, ATL/MFC and Windows SDK
versions required by the pinned Chromium revision, a short NTFS checkout path,
and enough space for the complete Chromium source and build output.

```powershell
python scripts/windows/engine.py all --root C:\bay-engine --output C:\bay-artifacts
# Stage the matching engine artifact through scripts/windows/build-app.py.
pwsh -File scripts/windows/smoke.ps1 -AppPath C:\bay-app\Bay.exe -HostingSpike
```

The Chromium target `chrome/browser/bay/webui:runtime_unittests` exercises the
browser-side privacy projections and command envelopes. Build and run it with
the same output configuration as the engine.

`smoke.ps1` checks process and window liveness. Complete the manual hosting gate
on the visible diagnostic page separately.
