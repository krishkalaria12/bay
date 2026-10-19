# Windows desktop builds

Windows 10 and Windows 11, x64, are the targets. Mica requires Windows 11 22H2;
earlier systems use a solid backdrop. Bay compiles Chrome with
its own WebUI and SurfaceEmbed tab host. The React UI is a local web bundle in
`bay-ui/`, served as `chrome://bay`. No React Native Windows runtime, CEF DLL or
bootstrap launcher ships. The macOS build remains separate.

## Engine

The pin is `engine/patches/build/engine-lock.json`. It matches macOS's existing
Chromium revision. The pinned tree's `docs/windows_build_instructions.md`
requires Visual Studio 2026 with Desktop C++, ATL/MFC, Windows SDK
10.0.28000.2270, and SDK debugging tools 26100.3323+. Use Python 3.12, Git for
Windows, long path support, a short checkout path, and an NTFS SSD with at least
300 GB free and 64 GB RAM for a practical build.

From Developer PowerShell:

```powershell
python scripts/windows/engine.py all --root C:/bay-engine --output dist/engine
```

`download`, `prepare`, `build`, and `archive` run individually too. Preparation
records completed phases. A failed phase stops immediately; investigate a partly
applied ungoogled/domain phase before retrying, or use a new root. Existing source
checkouts are never reset. Bay's CEF patches and the patches that host Chrome's
views inside the macOS app are macOS-only in the series; the former CEF host for
Windows has been removed. CEF's checkout and upstream Chromium patch baseline
remain only so both platforms patch the same tree. GN sets `enable_cef=false` and
builds `chrome` using ordinary GN arguments. Do not run macOS shell scripts on
Windows.

The artifact contains `runtime/`, headers/import libraries and `manifest.json`;
matching PDBs are in a separate symbols ZIP. Its identity includes the engine
pin and Bay source/patch digest. Archiving refuses a build whose source digest
has changed since the last successful compilation. The generated
`native_host.mojom-webui.js` binding is included with the runtime.

## App and installer

Copy the artifact ZIP and its trusted SHA-256 from the engine build. Pin the
checksum in release configuration independently of the download location.

```powershell
python scripts/windows/fetch-engine.py --archive C:/artifacts/engine.zip --sha256 <trusted-sha256> --destination dist/windows-engine
python scripts/windows/build-app.py --engine dist/windows-engine --output dist/windows-app
pwsh -File scripts/windows/smoke.ps1 -AppPath dist/windows-app/Bay.exe
pwsh -File scripts/windows/package.ps1 -Version 0.1.0 -Unsigned
```

The app builder runs `pnpm --filter @bay/browser build:web`, copies the static
web export into `bay-ui/`, preserves matching generated Mojo bindings and stages
the verified Chrome runtime. `--skip-web-build` accepts an existing export. Use
a fresh output directory to prevent stale engine files from another revision.
The builder validates the local HTML entrypoint and its script references, walks
the generated Mojo module imports, and writes a checksum manifest for the staged
application. Verify it before packaging with:

```powershell
python scripts/windows/build-app.py --verify dist/windows-app
```

Packaging checks that manifest again against its copied input before editing PE
resources or signing. It then removes the manifest from the installer staging
directory, since its checksums describe the unsigned build. The original staged
build and manifest remain available for diagnosis. The signed installer and
update feed have their own final SHA-256.

Generated bindings come from Chromium's WebUI TypeScript build, not the legacy
Mojo JavaScript generator. Shared `chrome://resources/mojo/` runtime imports stay
in Chromium's standard resource PAKs.

Install Inno Setup 6 first. Unsigned installers are for local testing; their
updater is disabled. For signed builds, put the code-signing certificate in the
current user's certificate store and set `BAY_SIGNING_CERT_SHA1`. Alternatively,
set `BAY_SIGNING_DLIB` and `BAY_SIGNING_METADATA` for Azure Artifact Signing's
signtool extension. The Windows SDK's signtool.exe must be on PATH.

Set `BAY_WINDOWS_UPDATE_FEED` to the HTTPS channel JSON URL and
`BAY_WINDOWS_DOWNLOAD_BASE` to the HTTPS installer directory, then omit
`-Unsigned`. Every executable/DLL, the installer and uninstaller are signed.
The package command writes the installer, checksum, channel JSON and app PDB ZIP.
It reads release notes from `release-notes/<version>.md` when present. Publishing
these files is a separate release action.

The installer registers Bay in the current user's RegisteredApplications,
StartMenuInternet capabilities, HTTP/HTTPS/HTML/PDF ProgIDs, and Start menu AUMID.
It leaves Windows' protected UserChoice alone. Use Windows Settings to select
Bay as the default browser. Uninstall removes app-owned registration and files;
profiles outside the install directory remain available for reinstall.

## Updater protocol

Updater policy is embedded in Bay.exe as RCDATA resource 201 before final
Authenticode signing. The sidecar `update-config.json` mirrors it for version
and settings display; installation trust uses the signed resource. Policy fixes
the installed version, channel, feed origin, payload origins and publisher.
Certificate-store builds pin a thumbprint. Azure builds explicitly permit a
renewed trusted certificate with the identical publisher subject, since Azure
certificates are short lived. Certificate renewal never bypasses chain trust.

The installed `update.ps1` emits one JSON object on stdout and exits nonzero for
`status: error`. `State` reports signed configuration; `Check` reports
`available` or `up-to-date`; `Stage` downloads and validates without executing.
`Install` returns `installing` after starting an independent worker which waits
for the supplied original Bay process to exit before running the installer.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Mode Check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Mode Stage
powershell.exe -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Mode Install -ParentProcessId <bay-pid>
```

Automatic downloads use Stage. At normal app shutdown, the app may invoke
`Install -Deferred -UseStaged -ParentProcessId <bay-pid>` to apply a previously
verified cache without a network request or reopening the app. Immediate manual
installation waits up to two minutes for Bay to quit and then relaunches it.
Every install revalidates the cached file's checksum, Authenticode publisher,
newer signed installer version and allowed origin. Redirects are checked at each
hop. Isolated instances with `BAY_DATA_DIR` do not update an installed copy.

## CI and first Windows validation

`windows-checks.yml` runs Node, artifact/patch and updater-policy tests on Windows.
The app build job runs when repository variables `BAY_WINDOWS_ENGINE_URL` and
`BAY_WINDOWS_ENGINE_SHA256` point to a matching engine artifact. Engine changes
use the dedicated self-hosted `bay-engine` runner. The package workflow accepts
an explicit version/channel and supports certificate secrets in the
`windows-release` environment. It only uploads build artifacts.

The [hosting gate](hosting-gate.md) records Phase 2 separately from process
liveness. Run it on Windows 11 at 100% and 150%, and Windows 10. The smoke command
accepts `-HostingSpike` to launch that diagnostic page, but still checks only
process and window liveness.

Before a beta release, use clean Windows 10 and Windows 11 installations:

- Launch `--enable-features=Webium,SurfaceEmbed chrome://webui-browser` and test
  upstream tab embedding, then test `chrome://bay` with the packaged local UI.
- Install without elevation and launch without a dev server.
- Open HTTP, HTTPS, local HTML and PDF files through Windows associations.
- Choose Bay in Windows Settings and verify external links reuse the intended
  instance and profile.
- Exercise tabs, split panes, shortcuts, IME, permissions, extensions, downloads
  and nested menu/dialog loops.
- Check Narrator/NVDA, keyboard focus, high contrast, transparency disabled,
  100/150/200% scale, mixed-DPI monitors and Intel/AMD/NVIDIA graphics.
- Update a signed build; reject altered, wrong-publisher and older payloads.
  Confirm staged automatic updates apply only after the browser exits.
- Uninstall, check registrations disappear and reinstall to confirm the profile
  survives. Inspect Crashpad dumps with the matching PDB ZIP.

Cross-platform tests do not establish these GUI/runtime results. Signing also
does not guarantee SmartScreen reputation for a new publisher.

References: [Chromium Windows build instructions](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_build_instructions.md),
[Inno Setup signing](https://jrsoftware.org/ishelp/topic_setup_signtool.htm),
[Windows default applications](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs).
