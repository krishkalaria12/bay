# Windows desktop builds

Windows 11 22H2 or later, x64, is the initial target. Engine compilation runs on
Windows, not under macOS cross compilation. The existing macOS build stays separate.

## Engine

The pin is `engine/patches/build/engine-lock.json`. It matches the existing
macOS CEF/Chromium revision. The pinned tree's
`docs/windows_build_instructions.md` requires Visual Studio 2026 with Desktop
C++, ATL/MFC, Windows SDK 10.0.28000.2270, and SDK debugging tools 26100.3323+.
Use Python 3.12, Git for Windows, long path support, a short checkout path, and
an NTFS SSD with at least 300 GB free and 64 GB RAM for a practical build.

From Developer PowerShell:

```powershell
python scripts/windows/engine.py all --root C:/bay-engine --output dist/engine
```

`download`, `prepare`, `build`, and `archive` run individually too. Preparation
records completed phases. A failed phase stops immediately; investigate a partly
applied ungoogled/domain phase before retrying, or use a new root. Existing source
checkouts are never reset. `build` reapplies Bay layers and checks patch-series
reproduction before compiling. Do not run the macOS shell scripts on Windows.

The artifact contains `runtime/`, `include/`, and `manifest.json`; matching PDBs
are in a separate symbols ZIP. Its identity includes the engine pin and Bay
source/patch digest. It includes the pinned CEF bootstrap launcher and both
NNCore process DLLs. CEF 154's Windows sandbox uses a bootstrap executable plus a
client DLL; Bay.exe is a copy of bootstrap.exe and Bay.dll exports RunWinMain.
The helper has the same bootstrap/client pair. Do not disable the sandbox to
work around a missing runtime file.

## App and installer

Copy the artifact ZIP and its trusted SHA-256 from the engine build. A downloaded
checksum must be pinned in release configuration independently of the download.

```powershell
python scripts/windows/fetch-engine.py --archive C:/artifacts/engine.zip --sha256 <trusted-sha256> --destination dist/windows-engine
pwsh -File apps/browser/windows/build.ps1 -Configuration Release -EngineDirectory "$pwd/dist/windows-engine"
pwsh -File scripts/windows/smoke.ps1 -AppPath apps/browser/windows/x64/Release/Bay/Bay.exe
pwsh -File scripts/windows/package.ps1 -Version 0.1.0 -Unsigned
```

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

The installed `update.ps1` checks the channel, increasing version, SHA-256,
trusted Authenticode chain, pinned publisher certificate, and signed installer
version before running the per-user installer. `-CheckOnly` reads availability.
The host can invoke this script for its update command. Certificate rotation
requires shipping the new trusted thumbprint in a release before using it.

The installer registers Bay in the current user's RegisteredApplications,
StartMenuInternet capabilities, HTTP/HTTPS/HTML/PDF ProgIDs, and Start menu AUMID.
It leaves Windows' protected UserChoice alone. Use Windows Settings to select
Bay as the default browser. Uninstall removes app-owned registration and files;
profiles outside the install directory remain available for reinstall.

## CI and first Windows validation

`windows-checks.yml` runs Node and artifact/patch tests on Windows. The app build
job runs when repository variables `BAY_WINDOWS_ENGINE_URL` and
`BAY_WINDOWS_ENGINE_SHA256` point to the matching engine artifact. Engine changes
use the dedicated self-hosted `bay-engine` runner. The package workflow accepts
an explicit version/channel and supports certificate secrets in the
`windows-release` environment. It only uploads build artifacts.

Before a beta release, run these checks on a clean Windows 11 VM:

- Install without elevation; launch a Release bundle without Metro.
- Open HTTP, HTTPS, a local HTML file and a PDF through Windows associations.
- Choose Bay in Windows Settings, then verify external links reach the existing
  instance and the selected profile.
- Exercise tabs, split panes, keyboard shortcuts, IME, permission prompts,
  extensions, downloads and nested menu/dialog loops.
- Check Narrator/NVDA, keyboard focus, high contrast, transparency disabled,
  100/150/200% scale, mixed-DPI monitors and Intel/AMD/NVIDIA graphics.
- Install a signed version, publish the next signed version's channel JSON,
  update it, then reject modified, wrong-publisher and older installer payloads.
- Uninstall, verify app-owned registrations disappear, and reinstall to confirm
  the user's profile survives. Inspect Crashpad dumps with the matching PDB ZIP.

The scripts' cross-platform tests do not establish these GUI/runtime results.
Signing also does not guarantee SmartScreen reputation for a new publisher.

References: [Chromium Windows build instructions](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_build_instructions.md),
[CEF sandbox setup](https://chromiumembedded.github.io/cef/sandbox_setup),
[Inno Setup signing](https://jrsoftware.org/ishelp/topic_setup_signtool.htm),
[Windows default applications](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs).
