# Linux port: work split

How the rest of the [Linux port plan](linux-port-plan.html) splits between two developers, **K** and **D**, so both can work at the same time.
Written 23 Oct 2026, against `feat/linux` at `398b8d0e`.

The work runs in two stages:

1. **Code.** Every code item is written first, by both people in parallel. None of it needs a Linux machine.
2. **Linux testing and runtime.** This starts only after every code item is done. D has the Linux machine, so D builds and runs everything on it. K fixes what D finds in K's areas and wires up CI.

The code split follows ownership, so each person mostly works in their own files:

- **K** owns the engine and host: Chromium patches, `chrome/browser/bay/webui` system methods, the frame and window rules.
- **D** owns data, UI and shipping: import, sync and secrets, `BayKeychain`, the web UI gaps and packaging.

Sizes are rough: S = 1, M = 2, L = 3, XL = 5. Stage 1 is about 25 points each. In stage 2, D runs about 19 points of testing, and K fixes what it finds in K's areas and sets up CI.

## Already done

These need no new code, only the Linux runtime checks in stage 2.

- Seams: the series takes `linux` and comma lists, `scripts/engine.py --platform linux` exists, Linux has its capability column, and the shared runtime is switched on by web host.
- Host sources:
  - The CSD frame (`frame_linux`).
  - Notifications.
  - The Safe Storage naming patch and the fixed-key warning (`BayCEF.secretStorage`).
  - `prompt`, `confirm`, `showMenu`, `pickFiles` and `fileIcon` through `ShellUI`.
  - Documents (`DocumentStore`), clipboard, appearance and file operations (`ShellFiles`).
- Engine siblings: `nn_downloads_linux.cc`, `nn_external_apps_linux.cc`, and shared Aura PiP.

None of the native test binaries have been linked or run. The shared code split out of `platform_services_win.cc` has not been compiled on Windows.

## Working rules

- **Branches.** Each person works on short branches off `feat/linux` (`feat/linux-k-*` and `feat/linux-d-*`) and merges them back into `feat/linux`. Merge, don't rebase shared history. Pull `feat/linux` before starting each item.
- **Order.** All of stage 1 first. The engine build, the hosting gate and all Linux testing wait for stage 2, even on D's machine.
- **Checks before each commit:**
  - Typechecks, JS and Python tests, the contracts check, lint and format.
  - Linux x64 release and DCHECK syntax checks for changed native sources.
- **Commits.** One line each, `type(scope): subject`, lowercase. Split big changes into atomic commits.
- **Docs.** When a slice lands, add a dated progress paragraph to `docs/linux-port-plan.html` and tick its box here.

### Shared files

Both people touch a few files, so merge conflicts will happen. That's fine: resolve them in the merge. Files where conflicts are likely:

- `webui/native_host.{h,cc}` and `native_host_unittest.cc` (the Linux method list)
- `webui/platform_services_win.cc` (K1 and D3 both move methods out of it)
- `webui/BUILD.gn` and `bay/data/BUILD.gn`
- `engine/patches/series`
- `docs/linux-port-plan.html`

A few things help when merging:

- Re-run the contracts generator instead of hand-merging the generated `native_contracts.g.h`.
- Run `gn format` on merged `BUILD.gn` files.
- Run `oxfmt` on the plan doc.

### Agreed up front

Agree these early so neither person blocks the other:

- The binary is named `bay` and installs to `/opt/bay`, with `/usr/bin/bay` pointing at a wrapper. K's branding patch (K4) produces this; D's packaging (D5) consumes it.
- Packaging reads the engine archive layout that `scripts/engine.py --platform linux archive` already writes. Stage 1 packaging is tested with fixtures. The first real archive comes from the stage 2 build.
- The window-button layout snapshot field (K2) is named and typed in `nativeContracts.ts` before either side codes against it.

## Stage 1: code

### K: engine, host and window

- [ ] **K1 · Remaining system methods (M+M+S+S+S = 7).** Today these are advertised only on Windows. Move each to a shared or `_linux` source and have Linux hosts advertise it.
  - `BaySystem.isDefaultBrowser` / `setAsDefaultBrowser`, through Chrome's `shell_integration_linux` (`xdg-settings`). Bundle `xdg-settings` as Helium does.
  - `BaySystem.launchAtLoginStatus` / `setLaunchAtLogin`, through an XDG autostart entry in `~/.config/autostart/bay.desktop`.
  - `BayApp.openExternalURL`, through `platform_util` / GIO, with the OpenURI portal when sandboxed.
  - `BayApp.systemInfo`, `environment` and `launchEnvironment` as host-info snapshots.
  - `BayApp.updaterState`, which reports that the package manager handles updates and offers no in-app updater.
  - Tests in the existing style: fakes for external effects, plus host tests for advertisement, both host roles and teardown.
- [ ] **K2 · Frame follow-ups (M+M = 4).**
  - Read the desktop's button layout (the Settings portal's `org.gnome.desktop.wm.preferences button-layout`, falling back to GTK's decoration layout) and publish it as a snapshot.
  - Draw the caption buttons on the left or right to match, including with the right-docked sidebar.
  - Edge tiling state, and client shadows or insets for restored windows.
- [ ] **K3 · Wayland window rules (M+M = 4).**
  - Tab drag-out lets the compositor place the new window.
  - Session restore keeps size and maximized state only.
  - Activation from other apps uses xdg-activation tokens.
  - Check single instance and URL forwarding through `ProcessSingleton`.
  - Check that touchpad overscroll back/forward is on in M154.
- [ ] **K4 · Engine linking and branding sources (L+M+S+S = 7).**
  - `chromium-bay-layer-linux.patch`: link `//chrome/browser/bay` and `//bay/core` into the `chrome` binary.
  - `chromium-bay-branding-linux.patch`: binary name `bay`, the desktop file name, and AppArmor-friendly paths. Keep `chrome_sandbox` and `chrome_crashpad_handler`.
  - `03-ungoogled.py`: apply `0016-chromium-sandbox-pie` and `remove-disable-setuid-sandbox-as-bad-flag` on Linux.
  - List the patches in `series` and lift the Linux `prepare`/`build` refusal in `scripts/engine.py`. Add lock fields for the glibc floor and the sysroot.
- [ ] **K5 · Windows compile of shared code (M = 2).** Build the Windows target. It covers `document_store`, `shell_ui`, `shell_files`, `shell_clipboard`, `shell_appearance` and the trimmed `platform_services_win.cc`. Fix anything that breaks, then run the Windows native tests.

### D: data, UI and shipping

- [ ] **D1 · Sync crypto and key store (L+M = 5).**
  - Split `packages/sync/windows/SyncCrypto.cpp` into backends: CNG on Windows, BoringSSL on Linux.
  - The Linux backend must match `tests/golden.json` byte for byte.
  - `SyncKeyStore` on libsecret. With no Secret Service, ask for the recovery phrase each session and never write the key to disk.
  - A Linux version of `RecoveryKitWindows.cpp`.
  - `newDeviceId` and `deviceName` as snapshots.
- [ ] **D2 · Import on Linux (M+L+S+M = 8).**
  - Profile paths:
    - `~/.config/{google-chrome, chromium, BraveSoftware/Brave-Browser, vivaldi, opera, microsoft-edge}` and Helium's directory.
    - Firefox native, snap and Flatpak profiles.
    - Flatpak Chromium-family apps under `~/.var/app/*/config`.
    - Zen's own profiles and its Flatpak profiles.
  - Chromium secrets: v10 with the fixed key, and v11 from the Secret Service or KWallet "Safe Storage" item, after consent and keyring unlock. This is the Linux version of `packages/import/windows/Secrets.cpp`.
  - Check that Firefox's NSS `key4.db` reader works as is.
  - Open the `is_win` gate in `chrome/browser/bay/data/BUILD.gn` (currently `assert(is_win)`) and in `data_bridge.cc`. Replace the Windows-only `libs` and defines with `//third_party/sqlite` and BoringSSL. The readers, vault, sessions and SQLite code are shared.
- [ ] **D3 · BayKeychain (M = 2).** Move `get`, `set` and `delete` out of `platform_services_win.cc` into a libsecret Linux version. Linux hosts advertise them. Add tests with a fake secret backend.
- [ ] **D4 · UI gaps (S+M+S+M = 6).**
  - Icons: 19 names in `fluentGlyphs.web.ts` have no SVG path in `symbols.web.tsx`. Add them, and add a test that every symbol name the app uses has a path.
  - Edge peek and the auto-hide toolbar peek, driven only by in-window enter, move and leave events plus the hide delay. No global pointer queries.
  - Shortcuts: add `Ctrl+Q` and `F11`, never bind Super, and keep the Linux column of the shortcuts table complete.
  - High contrast and reduced motion, so Phase 5's usability check passes.
- [ ] **D5 · Packaging sources (XL = 5).**
  - `scripts/linux/release.sh` stages `/opt/bay` and packs `.tar.xz`, AppImage (zsync), `.deb`, `.rpm` and the AUR `bay-bin` PKGBUILD.
  - The wrapper script sets `CHROME_WRAPPER` and the library path.
  - Desktop integration: `bay.desktop` (MIME types, New Window and New Private Window actions), AppStream metainfo and hicolor icons.
  - The AppArmor userns profile, installed by postinst and offered by AppRun.
  - Native messaging directories, GPG signing hooks, and the `ldd` unresolved-library check.
  - Tested with fixture archives.

## Stage 2: Linux testing and runtime

Starts when every stage 1 box is ticked. D runs each step on the Linux machine and reports failures with logs. Whoever owns the area fixes it: K for the engine, host, frame and window code (K1–K5 and the host sources already done), and D for data, UI and packaging (D1–D5). Fixes are ordinary code commits, so K can make them without the machine.

- [ ] **T1 · Engine build (Phase 1, L = 3).** Follow prerequisite steps 1–7 directly on Arch and build the stock baseline. Then run `scripts/engine.py --platform linux prepare`, `build` and `archive`. Record the glibc floor and finalise the distro tiers. Every later step needs this.
- [ ] **T2 · Hosting gate (Phase 2, L = 3).** SurfaceEmbed painting on Wayland and X11 comes first, then the rest of the gate table on GNOME and KDE. Write the go/no-go record. If it fails, try GuestContents, then L‑A; K writes that fallback.
- [ ] **T3 · Native tests and Phase 3 acceptance (M = 2).**
  - Link and run all Linux native test targets in `docs/engine-cli.md`.
  - Check Phase 3's exit criteria: real tabs, split panes, popups, extensions, prompts, PiP, DevTools, and the same engine JSON as on Mac and Windows.
- [ ] **T4 · App boot and test ports (Phase 4, M = 2).**
  - The real `App.tsx` boots from Metro (`BAY_DEV=1`) and from the packed bundle.
  - Port `apps/browser/scripts/*-test.mjs` (shortcuts, windowing, tab drag, zoom-scroll) to run under `xvfb-run` and headless Weston.
  - Windowing tests assert behaviour, not coordinates, on Wayland.
- [ ] **T5 · Shell and desktop checks (Phases 5 and 8, M = 2).**
  - Snapping and tiling on GNOME, KDE and one wlroots compositor; caption buttons follow the desktop's layout.
  - GPUs: Mesa and NVIDIA on Wayland, VA-API, and the software fallback.
  - Displays: fractional scaling, mixed DPI and hot-plug.
  - Input: IME with fcitx5 and IBus, touchpad and touchscreen.
- [ ] **T6 · Data acceptance (Phase 6, M = 2).**
  - `packages/import/fixtures` give identical results on Linux.
  - One shared fixture vault opens on Mac, Windows and Linux.
  - A real keyring import works on GNOME Keyring and KWallet.
  - Folder sync: rename atomicity and inotify limits on Nextcloud, Syncthing, Dropbox, rclone and SMB/NFS.
- [ ] **T7 · Packages and VM matrix (Phase 7, L = 3).** On clean VMs (Ubuntu 24.04, Debian 13, Fedora, Arch, openSUSE Tumbleweed), each package must install, launch, become the default browser, update to the next build and uninstall. `chrome://sandbox` must show the namespace sandbox, including on Ubuntu with AppArmor on.
- [ ] **T8 · Accessibility and performance (Phase 8, M = 2).**
  - Orca across the UI and pages, and keyboard-only use.
  - Performance next to the Mac `scripts/perf` numbers: cold start, 50 tabs, frame times.

K during stage 2:

- [ ] **K6 · Fixes.** Fix the failures D reports in K's areas, then ask D to re-run the step.
- [ ] **K7 · CI (M = 2).** An app build from the archived engine on every PR, and smoke launches in distro containers, on GitHub's Ubuntu runners. This needs no local Linux machine.

## Dependencies

| Waits | On | Why |
| --- | --- | --- |
| Stage 2 | Every stage 1 item | Linux testing runs once, after all the code is written |
| T2–T8 | T1 | Linux runtime work needs a built engine |
| T1 engine build | K4 | The build needs the layer and branding patches |
| D5 final layout | K4 | Binary name and paths; until then, use the names agreed up front |
| K2 UI side | K2 snapshot field in `nativeContracts.ts` | Agree the field before coding against it |
| D2 data gate | D1 | `bay/data` on Linux needs the BoringSSL sync backend to link |
| K7 CI | T1 | CI builds the app from the archived engine |
| Beta (Phase 8 exit) | T8 and K7 | Every Mac test script has a Linux CI run, and the prerelease channel has no known crash for one release cycle |

Neither person needs the other's stage 1 work to start, except the agreed names above.
