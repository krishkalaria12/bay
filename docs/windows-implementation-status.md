# Windows implementation checkpoint

Updated 20 October 2026. Windows 10 and Windows 11 x64 are supported targets.
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
without session hydration.

The command migration now covers tab creation, selection, navigation, closing,
duplication, pinning and reordering; window creation, movement, restoration,
focus and space switching; and user settings/search-engine changes. The native
broker validates source ownership, public destinations and private isolation,
with 31 executed C++ tests against the pinned Chromium libraries. Creation can
open its initial command panel in the same commit. Little Bay moves its page
or creates and focuses a main window within one command, before its source
connection closes. Settings layout changes also
commit once across all windows, and extension-reported engines remain native
facts rather than renderer preferences.

Migrated UI paths include settings controls, bookmark opening, Little Bay,
internal-page opening, tab window drops, Google sign-in and meeting tab opens.
They use read-only projections and await returned IDs before follow-up work.
Two-client integration tests exercise concurrent commands, publication before
acknowledgement, duplicate requests, one native reconciliation/persistence owner,
and disconnects without falling back to the local writable store.

Behind `--bay-shared-runtime`, a browser-owned detached WebContents holds the
coordinator, authenticates document connections and retains accepted state for
bounded crash recovery. Native projections remove other windows' private data;
global engine, data and window events go to the coordinator. This experimental
mode deliberately stops before the legacy UI entry, which still owns global
services. The coordinator and visible UI entries are not wired together yet.
Additional application windows remain gated pending the remaining command
migration and service ownership. Group, split, peek, bookmark mutation, native
page-fact and other legacy UI paths still access the writable singleton. Global
service startup and cross-renderer page handoff must move to the coordinator
before enabling the shared UI entry. In-process two-client tests do not replace
native two-window acceptance. Live document IO now starts
explicitly instead of running when window UI imports its store.

Native updater and close-button shutdown preparation now participate in the
acknowledged final session save. Native page controls cover printing, saving,
screenshots, certificate details and media operations. Windows browser and
installer identities, executable names, associations and taskbar IDs now agree.
Remaining work includes shared service ownership, page fact routing, complete
native event/OS coverage and the Windows acceptance runs. The diagnostic page
does not establish a complete browser host.

## Frame, notifications and menus

Bay windows use their own Win32 frame (`frame_win.cc`, installed through
`chromium-bay-frame-win.patch`). DWM keeps the borders, shadow and Aero Snap;
the client area reaches the window's top, the top edge stays a resize border,
and the UI's caption buttons are drawn at the top right. The host reports the
UI's maximize button as `HTMAXBUTTON` so Windows 11 offers Snap Layouts over
it. On Windows 11 22H2 and later the window is translucent with a Mica system
backdrop behind the UI's glass material; `--bay-disable-mica` and Windows 10
use the solid theme colour. The macOS traffic-light space is no longer reserved
on Windows; every layout clears the caption buttons instead.

App notifications are Windows toasts through Chrome's notification bridge, with
the installer's AUMID and toast activator. Clicks received before the UI
subscribes are retained. Commands from the macOS menu bar are listed in the
command panel on Windows.

Windows-only sources now also pass a Windows-target syntax check on macOS
(Chromium's clang with mingw-w64 headers). Errors that come only from patches
outside that overlay, or from mingw's WinRT headers, are expected there.

## CEF host retired

The CEF C ABI host (`engine/nncore/src/bay/core/win`), its GN targets, its
generated call header and the engine archive's headers and import libraries are
gone. The patches that host Chrome's views inside the macOS app
(`chromium-webview-native-hosted`, `chromium-window-hosted`,
`chromium-window-docked-devtools`, `chromium-browser-view-hosted-fullscreen`)
are macOS-only. CEF's checkout and patcher still run on Windows only so both
platforms patch the same base tree.

The Windows series is checked on macOS against a Windows base: the macOS
`series-base`, plus the macOS tree's own file for each path only Windows
patches (those carry CEF's patcher, ungoogled and domain substitution, and no
Bay patch). `series.py materialize --platform win` must then report no errors.
This found a `chromium-bay-webui-window.patch` hunk that only applied on top of
a macOS-only patch; it is rebased.

## Windows Chrome opens itself

Until the shared runtime owns every window, one full UI document runs per
process. A normal window Chrome opens on its own while a Bay window exists (a
second launch with `--new-window`, a taskbar task, an extension's
`chrome.windows.create`) is absorbed: it is never shown, its document refuses
to start, and its tabs move into the most recently active Bay window. Pages in
another regular profile reopen there; private pages are dropped rather than
copied into a regular profile. Bay's own additional windows (private, Harbor,
settings, import) remain gated, and the taskbar jump list waits for them.

## Validation still required on Windows

Absorbed windows: with Bay open, run `Bay.exe --new-window https://example.com`
and check the page opens as a tab in the existing window with no second window
flashing. Frame: drag from the caption, double-click to maximize, resize from every edge
including the top, Snap Layouts on hovering maximize, Aero Snap, multi-monitor
DPI changes, maximized windows staying on their monitor, the caption buttons'
hover and click, and Mica with readable text in light and dark themes (then
again with `--bay-disable-mica`). Notifications: a toast appears, and clicking
it focuses its tab, including after a cold start from the toast.

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
