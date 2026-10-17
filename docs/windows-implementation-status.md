# Windows implementation checkpoint

Updated 17 October 2026. The target is Windows 11 22621+ on x64. The `ios`
directories contain the existing macOS native sources; they are not mobile
application targets.

The [port plan](windows-port-plan.html) changed its hosting decision on
17 October 2026: Bay's UI on Windows is now web-rendered. The React UI runs on
react-native-web as a Chrome WebUI page, tabs are SurfaceEmbed `<embed>`
elements, and the engine is NNCore (Chrome plus Bay's layer), as on macOS.
Nothing of the new host exists yet; Phase 0 starts it on macOS.

## Removed with the React Native for Windows host

The React Native for Windows app (`apps/browser/windows`), its native-module glue
(`WindowsHost.cpp`, `packages/nncore/windows`, `SyncModule`, `ImportModule`), the
`BayWindows` TurboModule spec, every `.windows.ts(x)` platform file, the
JavaScript animation engine, and the `react-native-windows` dependency, scripts,
workflow steps and licence notice. Recover any of it from commit `f9e87f27`. The
Segoe Fluent glyph table and the view fallbacks are worth porting to `.web.tsx`
files in Phase 4.

## Kept and checked on macOS

- `@bay/platform` centralizes desktop policy, capabilities, shortcut formatting,
  Control-click behavior and platform view props. Native modules and views have
  typed contracts covering all registered native names, and the generator also
  writes a C++ method catalog (`packages/platform/windows/NativeContracts.g.h`)
  for a native dispatcher.
- The JSON bridge envelopes (`nativeBridge.ts`) and their tests. The new host
  carries the same envelopes over Mojo.
- Windows import readers parse Chromium and Firefox bookmarks, history and
  sessions, Netscape HTML and password CSV. Portable C++ tests exercise CSV
  quoting, bookmark entities, Chromium sessions, committed SQLite WAL data and
  cancellation. Windows secret readers use DPAPI and Firefox NSS. Chromium
  app-bound secrets are refused with export guidance.
- The C++ sync implementation matches a Swift CryptoKit-generated encrypted
  envelope byte for byte. Tests cover tamper rejection, profile binding, recovery
  phrases and vault writes, reads and deletion. Windows crypto uses CNG; the
  macOS test adapter uses OpenSSL.
- Python tests cover platform patch selection, pinned engine arguments, build
  locking, artifact checksums, archive traversal and duplicate Windows paths.
- Windows CI runs the JavaScript checks, the browser tests, the portable sync and
  import tests with MSVC, the build-script tests and the patch selection.

## Kept until Phase 3 replaces it

The engine still builds through CEF: the C ABI host in
`engine/nncore/src/bay/core/win`, the CEF targets in `scripts/windows/engine.py`,
and the packaging scripts that expect its layout (`scripts/windows/package.ps1`
now needs `-AppDirectory`). Phase 3 switches the Windows build target to Chrome
and retires the CEF host.

## Next

1. Phase 0 on macOS: boot the UI on the web against stub modules, write the
   `@bay/platform` web wrappers, make every native call asynchronous, put a
   transport interface under the JSON bridge, and split NNCore's `.mm` files into
   portable `.cc` and macOS-only parts.
2. Phase 1 on a Windows machine: build the `chrome` target from the pinned tree
   with Bay's patches and run upstream's WebUI browser with SurfaceEmbed.
3. Phase 2: the hosting spike and its go/no-go record.

## Commands

On macOS:

```sh
pnpm typecheck
pnpm test
pnpm test:windows-build
pnpm test:windows-native
node packages/platform/scripts/native-contracts.mjs --check
python3 scripts/windows/generate-engine-calls.py --check
```

The portable native tests require C++17, `pkg-config` and OpenSSL on macOS. They
fetch a checksum-pinned nlohmann/json header into the temporary dependency cache.
On Windows, the same tests run from a Visual Studio developer environment and use
CNG.

On the Windows engine machine, install the Visual Studio, ATL/MFC and Windows SDK
versions required by the pinned Chromium revision. Use a short NTFS path and
allow enough space for the complete Chromium checkout and build output.

```powershell
python scripts/windows/engine.py all --root C:\bay-engine --output C:\bay-artifacts
```
