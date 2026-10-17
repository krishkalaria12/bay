# Windows implementation checkpoint

Updated 17 October 2026. The target is Windows 11 22621+ on x64. Bay supports
desktop macOS and Windows. The `ios` directories contain the existing macOS native
sources; they are not mobile application targets.

The full [port plan](windows-port-plan.html) is **not complete**. Windows native
sources have not been compiled or run on Windows, and several native services
still reject calls as unsupported. A successful JavaScript bundle or a window
appearing does not establish feature parity.

## Implemented and checked on macOS

- `@bay/platform` centralizes desktop policy, capabilities, shortcut formatting,
  Control-click behavior, native module resolution and platform view props.
- Native modules and views have typed contracts covering all 27 registered native
  names. Generation checks detect drift; Windows receives a C++ method catalog.
  Optional native methods appear only when the Windows host advertises them.
- Windows uses a JavaScript animation driver with timing, springs, sequences,
  repeats, interruption, reactions and reduced motion. macOS keeps Reanimated.
- Both platform TypeScript configurations pass. Both production JavaScript
  bundles have been built on macOS. Browser, platform, core, sync and import
  tests run through `pnpm test`.
- Little Bay (main's name for Arc's Little Arc) is used in code, native menus
  and visible text. Both native targets expose application API version 10, so
  old native builds require rebuilding.
- Windows import readers parse Chromium and Firefox bookmarks, history and
  sessions, Netscape HTML and password CSV. Portable C++ tests exercise CSV
  quoting, bookmark entities, Chromium sessions, committed SQLite WAL data and
  cancellation. Windows secret readers use DPAPI and Firefox NSS. Chromium
  app-bound secrets are refused with export guidance.
- The C++ sync implementation matches a Swift CryptoKit-generated encrypted
  envelope byte for byte. Tests also cover tamper rejection, profile binding,
  recovery phrases and vault writes, reads and deletion. Production Windows
  crypto uses CNG; the macOS C++ test adapter uses OpenSSL.
- Python tests cover platform patch selection, pinned engine arguments, build
  locking, artifact checksums, archive traversal and duplicate Windows paths.

## Written but awaiting Windows compilation and execution

- The engine has explicit macOS/Windows GN source selection, portable C++
  extractions, Windows external-app and PiP implementations, and a C host ABI.
- The Windows C ABI creates Chrome-style CEF child browsers, moves/resizes their
  HWNDs, navigates, finds text, evaluates JavaScript, opens DevTools and forwards
  events. Calls to Chromium services use a generated allowlist of callable
  exports. Private contexts have no disk cache and share within their window.
- The RNW 0.81.5 Fabric host is `Bay.dll`, loaded by CEF's sandbox bootstrap
  `Bay.exe`. Browser subprocesses use their own bootstrap and DLL. The host
  implements basic windows, file dialogs, document persistence, clipboard text,
  Credential Manager and selected engine services. Import work runs off the
  application UI thread and imported cookie/card values stay in native code.
- Windows source download, patching, build, artifact verification and packaging
  commands are present. Engine and application CI require an actual Windows
  toolchain and a built engine artifact. The installer registers per-user
  browser capabilities and an AUMID. Release signing requires publisher
  credentials supplied through configuration.
- The installer updater script verifies HTTPS metadata, checksums, the signed
  installer version and publisher certificate. The application update command
  and automatic update scheduling are still unwired.

## Remaining implementation work

1. Resolve the plan's hosting gate on Windows. The current child-HWND baseline
   does not implement owned popup hosts for React overlays. Command panels,
   find bars, popovers, split panes, focus, DPI changes and accessibility need
   verification and, where necessary, a hosting change.
2. Finish Windows engine module coverage. Revisioned tab-strip transactions,
   transfer/adoption, content blocking, Chrome UI services, extension prompts,
   media/capture integration and parts of the WebView handle are incomplete.
   `packages/nncore/windows/NativeServices.cpp` and `EngineBridge.cpp` currently
   throw for the missing services; they do not stand in for implementations.
3. Finish shell services: global native shortcut dispatch and remapping,
   notifications, image clipboard/file icons, native file drag/drop, dialogs
   such as text prompts, and application updater integration. Complete default
   browser launch/relaunch behavior and theme-change notifications.
4. Complete the Mac C ABI migration. The existing Mac host still uses
   `NNCore.h`; it is not yet a thin wrapper over `nncore_c.h`.
5. Compile and test CNG, DPAPI, Credential Manager, NSS, OneDrive placeholders,
   installer upgrade/uninstall and signing on Windows. Complete recovery QR,
   preview and native share behavior; those methods currently have limited
   fallbacks. Validate all browser-family imports against Windows profiles.
6. Run the plan's actual native acceptance matrix, including existing macOS
   shortcuts, windowing, hover, tab drag and zoom scripts after rebuilding.

## Commands

On macOS:

```sh
pnpm typecheck
pnpm typecheck:windows
pnpm test
pnpm test:windows-build
pnpm test:windows-native
node packages/platform/scripts/native-contracts.mjs --check
python3 scripts/windows/generate-engine-calls.py --check
```

The portable native tests require C++17, `pkg-config` and OpenSSL on macOS. They
fetch a checksum-pinned nlohmann/json header into the temporary dependency cache.
On Windows, the same tests require Visual Studio Developer PowerShell and use CNG.

On the Windows engine machine, install the Visual Studio, ATL/MFC and Windows
SDK versions required by the pinned Chromium revision. Use a short NTFS path and
allow enough space for the complete Chromium checkout and build output.

```powershell
python scripts/windows/engine.py all --root C:\bay-engine --output C:\bay-artifacts
```

After obtaining the artifact, verify and extract it using its trusted checksum:

```powershell
python scripts/windows/fetch-engine.py --archive C:\bay-artifacts\ENGINE.zip --sha256 TRUSTED_SHA256 --destination C:\bay-engine-artifact
$env:BAY_WINDOWS_ENGINE_DIR = 'C:\bay-engine-artifact'
pnpm install --frozen-lockfile
pnpm dev
# In a second terminal:
pnpm windows
```

`apps/browser/windows/build.ps1` builds and stages the app and sandbox bootstrap.
Use `-Configuration Release` for an embedded production bundle. The app build is
an integration gate; fix native compilation/runtime failures before proceeding.

```powershell
pwsh -File scripts/windows/smoke.ps1 -AppPath apps/browser/windows/x64/Release/Bay/Bay.exe
```

The smoke check verifies that an isolated app creates a window and stays running.
It does not test page rendering, overlays or browser features. Preserve its
isolated profile for logs when a Windows test fails.
