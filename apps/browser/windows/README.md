# Windows desktop host

Bay uses React Native Windows 0.81.5 with Fabric, Hermes and Windows App SDK.
The project starts from Microsoft's `cpp-app` template and hosts one React Native
island per browser window. It supports x64 desktop Windows only.

Windows App SDK is deployed with the app. The DLL explicitly enables
[registration-free WinRT initialization](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/self-contained-deploy/deploy-self-contained-apps)
because the CEF launcher does not initialize it.

The host is `Bay.dll`, loaded by the CEF 154 sandbox bootstrap distributed as
`Bay.exe`. Do not replace that executable with an ordinary WinMain wrapper and do
not disable the Chromium sandbox. The bootstrap invokes the exported `RunWinMain`
entry point with its sandbox information. Browser subprocesses exit through CEF
before React Native or COM starts.

Build `Bay.sln` using MSBuild on Windows after restoring JavaScript and NuGet
dependencies. Output goes to `windows/x64/{Debug,Release}/Bay/`. The engine bundle
must provide `NNCore.dll`, `libcef.dll`, `chrome_elf.dll`, CEF resources and locales,
and the matching bootstrap executable. Release also needs `Bundle/index.windows.bundle`.

`BAY_DATA_DIR` selects a separate absolute data directory. Without it, Bay writes
under `%LOCALAPPDATA%\Bay`. `BAY_BACKGROUND=1` creates hidden windows for automation.
Document reads/writes cannot escape this directory. Writes replace files atomically.
Credential Manager entries include the isolated directory so test builds do not
read or replace the main profile's credentials.

CEF renders into child HWNDs inside each React window. Layout coordinates sent
from JavaScript are device-independent pixels and converted using the owning
window's current DPI. This implements the baseline HWND hosting option. Transparent
React overlays above a Chromium HWND remain a Windows integration gate. Verify
hit testing, overlays, popups, DPI transitions, focus, drag and fullscreen on the
Windows machine before accepting the hosting design.

`BayWindows` is the native TurboModule dispatcher. It returns JSON envelopes:
`{"value":...}` or `{"error":{"code":"...","message":"..."}}`. Every unsupported
method rejects explicitly. Optional modules must be listed only when implemented.
The JS contract version is 1; the application API version is 9. Native events
use the name `ModuleName.eventName` through `RCTDeviceEventEmitter`.
