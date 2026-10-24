# Linux port: work split

How the rest of the [Linux port plan](linux-port-plan.html) splits between three developers, **K**, **D** and **A**, so all three can work in parallel.
Written 23 Oct 2026, against `feat/linux` at `398b8d0e`. Ownership updated 23 Oct 2026: K has completed K4, D is working on D1, and A is joining. Keep in-progress assignments with their current owners.

The work runs in two stages:

1. **Code.** Every code item is written first, by all three developers in parallel. None of it needs a Linux machine.
2. **Linux testing and runtime.** This starts only after every code item is done. D and A both have Arch machines and split the build and runtime checks below. K fixes failures in the engine, host, import and keychain; D and A fix failures in their own code. A owns CI. Having an Arch machine does not move any runtime work into stage 1.

The code split follows ownership, so each person mostly works in their own files:

- **K** owns the engine and host: Chromium patches, `chrome/browser/bay/webui` system methods, the frame and window rules, plus Linux import and `BayKeychain`.
- **D** owns sync crypto and the sync key store.
- **A** owns the web UI gaps, packaging and CI.

Sizes are rough: S = 1, M = 2, L = 3, XL = 5. K keeps the largest stage 1 allocation at 32 points: 30 complete and 2 remaining. D has 5 points and A has 11 points, all remaining. These totals follow the item estimates below. In stage 2, D runs 10 points of testing, A runs 9 points and adds 2 points of CI, and K handles engine, host, import and keychain fixes as needed.

A takes the former D4 and D5 as A2 and A3, plus the former K7 as A4. K takes the former D2 as K8 and the former A1, originally D3, as K9. K1–K4, K6 and D1 keep their identifiers; K7 remains the former CI task now owned by A4.

## Already done

These need no new code, only the Linux runtime checks in stage 2.

- Seams: the series takes `linux` and comma lists, `scripts/engine.py --platform linux` exists, Linux has its capability column, and the shared runtime is switched on by web host.
- K4 engine sources: Linux linking and branding patches, sandbox patch selection, and exact sysroot provenance/preflight. The measured glibc floor remains unknown until T1.
- Host sources:
  - The CSD frame (`frame_linux`), tiled-edge insets, and K2 desktop button-layout snapshots with reactive caption placement.
  - Notifications.
  - The Safe Storage naming patch and the fixed-key warning (`BayCEF.secretStorage`).
  - `prompt`, `confirm`, `showMenu`, `pickFiles` and `fileIcon` through `ShellUI`.
  - Documents (`DocumentStore`), clipboard, appearance and file operations (`ShellFiles`).
  - K3 window rules: size-only placement and restore on Wayland, launch tokens, and links Chrome adds to a Bay window offered as Bay tabs.
  - K1 system methods: default browser, per-user XDG autostart, external URLs, app-info/environment snapshots and package-managed updater status. The engine archive includes the XDG helper siblings; K4 supplies the desktop identity, and A3 still supplies installed desktop integration.
- Engine siblings: `nn_downloads_linux.cc`, `nn_external_apps_linux.cc`, and shared Aura PiP.

None of the Linux native test binaries have been linked or run.

## Working rules

- **Branches.** Each person works on short branches off `feat/linux` (`feat/linux-k-*`, `feat/linux-d-*` and `feat/linux-a-*`) and merges them back into `feat/linux`. Merge, don't rebase shared history. Pull `feat/linux` before starting each item.
- **Order.** All of stage 1 first. The engine build, the hosting gate and all Linux testing wait for stage 2, even on D's and A's machines.
- **Checks before each commit:**
  - Typechecks, JS and Python tests, the contracts check, lint and format.
  - Linux x64 release and DCHECK syntax checks for changed native sources.
- **Commits.** One line each, `type(scope): subject`, lowercase. Split big changes into atomic commits.
- **Docs.** When a slice lands, add a dated progress paragraph to `docs/linux-port-plan.html` and tick its box here.

### Shared files

All three developers touch a few files, so merge conflicts will happen. That's fine: resolve them in the merge. Files where conflicts are likely:

- `webui/native_host.{h,cc}` and `native_host_unittest.cc` (the Linux method list)
- `webui/platform_services_win.cc` (K1 and K9 both move methods out of it)
- `webui/BUILD.gn` and `bay/data/BUILD.gn`
- `engine/patches/series`
- `docs/linux-port-plan.html`

A few things help when merging:

- Re-run the contracts generator instead of hand-merging the generated `native_contracts.g.h`.
- Run `gn format` on merged `BUILD.gn` files.
- Run `oxfmt` on the plan doc.

### Agreed up front

Use these agreements so ownership changes do not block implementation:

- The binary is named `bay` and installs to `/opt/bay`, with `/usr/bin/bay` pointing at a wrapper. K's branding patch (K4) produces this; A's packaging (A3) consumes it.
- Packaging reads the engine archive layout that `scripts/engine.py --platform linux archive` already writes. Stage 1 packaging is tested with fixtures. The first real archive comes from the stage 2 build.
- The window-button layout snapshot field (K2) is named and typed in `nativeContracts.ts` before either side codes against it.

## Stage 1: code

### K: engine, host, window, import and keychain

- [x] **K1 · Remaining system methods (M+M+S+S+S = 7).** Code complete 23 Oct 2026. Linux hosts advertise these through shared or `_linux` services; native execution and desktop verification remain deferred.
  - `BaySystem.isDefaultBrowser` / `setAsDefaultBrowser`, through Chrome's `shell_integration_linux` (`xdg-settings`). Bundle `xdg-settings` as Helium does.
  - `BaySystem.launchAtLoginStatus` / `setLaunchAtLogin`, through an XDG autostart entry in `~/.config/autostart/bay.desktop`.
  - `BayApp.openExternalURL`, through `platform_util` / GIO, with the OpenURI portal when sandboxed.
  - `BayApp.systemInfo`, `environment` and `launchEnvironment` as host-info snapshots.
  - `BayApp.updaterState`, which reports that the package manager handles updates and offers no in-app updater.
  - Tests in the existing style: fakes for external effects, plus host tests for advertisement, both host roles and teardown.
- [x] **K2 · Frame follow-ups (M+M = 4).** Code complete 23 Oct 2026. Portal-first button ordering with GTK fallback, reactive caption placement and tiled-edge client insets are implemented; native execution and desktop verification remain deferred.
  - Read the desktop's button layout (the Settings portal's `org.gnome.desktop.wm.preferences button-layout`, falling back to GTK's decoration layout) and publish it as a snapshot.
  - Draw the caption buttons on the left or right to match, including with the right-docked sidebar.
  - Edge tiling state, and client shadows or insets for restored windows.
- [x] **K3 · Wayland window rules (M+M = 4).** Code complete 23 Oct 2026. Size-only placement and restore without global coordinates, launch tokens for new and absorbed windows, and forwarded links offered as Bay tabs are implemented; touchpad back/forward is on by default in M154. Native execution and desktop verification remain deferred.
  - Tab drag-out lets the compositor place the new window.
  - Session restore keeps size and maximized state only.
  - Activation from other apps uses xdg-activation tokens.
  - Check single instance and URL forwarding through `ProcessSingleton`.
  - Check that touchpad overscroll back/forward is on in M154.
- [x] **K4 · Engine linking and branding sources (L+M+S+S = 7).** Code complete 23 Oct 2026. Linking, branding, Linux sandbox patch selection and exact sysroot preflight are implemented. Linux preparation, GN/link validation and runtime checks remain deferred; `minimumGlibc` stays `null` until T1 measures a built artifact.
  - `chromium-bay-layer-linux.patch`: link `//chrome/browser/bay` and `//bay/core` into the `chrome` binary.
  - `chromium-bay-branding-linux.patch`: binary name `bay`, the desktop file name, and AppArmor-friendly paths. Keep `chrome_sandbox` and `chrome_crashpad_handler`.
  - `03-ungoogled.py`: apply `0016-chromium-sandbox-pie` and `remove-disable-setuid-sandbox-as-bad-flag` on Linux.
  - List the patches in `series` and lift the Linux `prepare`/`build` refusal in `scripts/engine.py`. Add lock fields for the glibc floor and the sysroot.
- [x] **K8 · Import on Linux (M+L+S+M = 8), previously D2.** Code complete 24 Oct 2026 in `feat/linux-k-import`. Native, snap and Flatpak discovery, v10/v11 secrets, consent and unlock caching, isolated NSS profiles, Linux BayImport host dispatch and single-file pickers are implemented. Mac fixture checks cover the shared readers, both keyring protocols and real NSS `key4.db` data; Linux release/DCHECK syntax checks pass. Final Linux linking still depends on D1, and native/desktop execution remains deferred to stage 2.
  - Profile paths:
    - `~/.config/{google-chrome, chromium, BraveSoftware/Brave-Browser, vivaldi, opera, microsoft-edge}` and Helium's directory.
    - Firefox native, snap and Flatpak profiles, including legacy and current XDG locations.
    - Flatpak Chromium-family apps under `~/.var/app/*/config`.
    - Zen's own profiles and its Flatpak profiles.
  - Chromium secrets: v10 with the fixed key, and v11 from the Secret Service or KWallet "Safe Storage" item, after consent and keyring unlock. This is the Linux version of `packages/import/windows/Secrets.cpp`.
    - The import window can continue without unlocking, retaining v10 passwords and reporting blocked v11 rows. Unlocks are bound to canonical source roots; forgetting keys cancels late unlock results.
  - Check that Firefox's NSS `key4.db` reader works as is.
  - Open the `is_win` gate in `chrome/browser/bay/data/BUILD.gn` (currently `assert(is_win)`) and in `data_bridge.cc`. Replace the Windows-only `libs` and defines with `//third_party/sqlite` and BoringSSL. The readers, vault, sessions and SQLite code are shared.

- [ ] **K9 · BayKeychain (M = 2), previously A1 and D3.** Move `get`, `set` and `delete` out of `platform_services_win.cc` into a libsecret Linux version. Linux hosts advertise them. Add tests with a fake secret backend.

### D: sync crypto and key store

- [ ] **D1 · Sync crypto and key store (L+M = 5).** In progress with D.
  - Split `packages/sync/windows/SyncCrypto.cpp` into backends: CNG on Windows, BoringSSL on Linux.
  - The Linux backend must match `tests/golden.json` byte for byte.
  - `SyncKeyStore` on libsecret. With no Secret Service, ask for the recovery phrase each session and never write the key to disk.
  - A Linux version of `RecoveryKitWindows.cpp`.
  - `newDeviceId` and `deviceName` as snapshots.
  - **23 Oct 2026:** D1 sources and portable checks are implemented on `feat/linux-d-sync`; the box stays open until the slice lands on `feat/linux`. Crypto uses the exact Chromium BoringSSL pin and matches the golden envelope. Fake Secret Service tests cover memory-only sessions and recovery; recovery exports have private files and an asynchronous picker adapter. D2 still opens and advertises the Linux data bridge, owns `SyncUI` and dispatches it before worker calls, and supplies Linux password reading. Chromium-dependent syntax and native tests need the stage 2 checkout/sysroot; no engine or desktop runtime checks have run. Details and commands are in the dated Phase 6 progress in the plan.

### A: UI and shipping

- [x] **A2 · UI gaps (S+M+S+M = 6), previously D4.** Code complete 24 Oct 2026 on `feat/linux-a-ui-gaps`; desktop checks remain for stage 2.
  - Icons: 19 names in `fluentGlyphs.web.ts` have no SVG path in `symbols.web.tsx`. Add them, and add a test that every symbol name the app uses has a path.
  - Edge peek and the auto-hide toolbar peek, driven only by in-window enter, move and leave events plus the hide delay. No global pointer queries.
  - Shortcuts: add `Ctrl+Q` and `F11`, never bind Super, and keep the Linux column of the shortcuts table complete.
  - High contrast and reduced motion, so Phase 5's usability check passes.
  - **24 Oct 2026:** 204 icons were missing, not 19, counting the icon pickers; all are drawn and `symbols.test.mjs` guards them. `LINUX_SHORTCUTS` labels Ctrl+Q and F11 and a test keeps Super out; F11 runs through Chrome's own accelerator table, and the WebUI window quits on Ctrl+Q (`quit_shortcut_linux.h`). High contrast follows `prefers-contrast: more`, with a WCAG AA test; reduced motion needed no code. Edge peeks now hide when the pointer leaves the edge strip out of the window. Details are in Phase 5's progress in the plan.
- [x] **A3 · Packaging sources (XL = 5), previously D5.** Code complete 24 Oct 2026 on `feat/linux-a-packaging`; VM checks remain for T7.
  - `scripts/linux/release.sh` stages `/opt/bay` and packs `.tar.xz`, AppImage (zsync), `.deb`, `.rpm` and the AUR `bay-bin` PKGBUILD.
  - The wrapper script sets `CHROME_WRAPPER` and the library path.
  - Desktop integration: `bay.desktop` (MIME types, New Window and New Private Window actions), AppStream metainfo and hicolor icons.
  - The AppArmor userns profile, installed by postinst and offered by AppRun.
  - Native messaging directories, GPG signing hooks, and the `ldd` unresolved-library check.
  - Tested with fixture archives.
  - **24 Oct 2026:** `scripts/linux/build-app.py` and `release.sh` with templates in `packaging/linux/` (see its README). All formats are implemented; fixture tests run the tarball, AUR (`makepkg`), signing and validation here, and the .deb, .rpm and AppImage tests run where `dpkg-deb`, `rpmbuild` and `appimagetool` are installed. Debian dependencies stay unversioned until T1 measures the glibc floor.

## Stage 2: Linux testing and runtime

Starts when every stage 1 box is ticked. D and A run their assigned steps on Arch and report failures with logs. K owns engine, host, frame, window, import and keychain fixes, including K1–K4, K8–K9 and the host sources already done. D owns sync crypto and key store fixes, D1. A owns UI and packaging fixes, A2–A3. Fixes are ordinary code commits, so K can make them without a Linux machine.

D produces the T1 engine archive and shares it with A before A starts runtime checks. Both use the same engine revision and app commit. After T1, D and A can run independent checks in parallel; T2 is the hosting go/no-go gate for app-level acceptance. Each runner re-runs failed checks after the owner fixes them.

- [ ] **T1 · D · Engine build (Phase 1, L = 3).** Follow prerequisite steps 1–7 directly on Arch and build the stock baseline. Then run `scripts/engine.py --platform linux prepare`, `build` and `archive`. Record the glibc floor and finalise the distro tiers. Every later step needs this.
- [ ] **T2 · D · Hosting gate (Phase 2, L = 3).** SurfaceEmbed painting on Wayland and X11 comes first, then the rest of the gate table on GNOME and KDE. Write the go/no-go record. If it fails, try GuestContents, then L‑A; K writes that fallback.
- [ ] **T3 · D · Native tests and Phase 3 acceptance (M = 2).**
  - Link and run all Linux native test targets in `docs/engine-cli.md`.
  - Check Phase 3's exit criteria: real tabs, split panes, popups, extensions, prompts, PiP, DevTools, and the same engine JSON as on Mac and Windows.
- [ ] **T4 · A · App boot and test ports (Phase 4, M = 2).**
  - The real `App.tsx` boots from Metro (`BAY_DEV=1`) and from the packed bundle.
  - Port `apps/browser/scripts/*-test.mjs` (shortcuts, windowing, tab drag, zoom-scroll) to run under `xvfb-run` and headless Weston.
  - Windowing tests assert behaviour, not coordinates, on Wayland.
- [ ] **T5 · A · Shell and desktop checks (Phases 5 and 8, M = 2).**
  - Snapping and tiling on GNOME, KDE and one wlroots compositor; caption buttons follow the desktop's layout.
  - GPUs: Mesa and NVIDIA on Wayland, VA-API, and the software fallback.
  - Displays: fractional scaling, mixed DPI and hot-plug.
  - Input: IME with fcitx5 and IBus, touchpad and touchscreen.
- [ ] **T6 · D · Data acceptance (Phase 6, M = 2).**
  - `packages/import/fixtures` give identical results on Linux.
  - One shared fixture vault opens on Mac, Windows and Linux.
  - A real keyring import works on GNOME Keyring and KWallet.
  - Folder sync: rename atomicity and inotify limits on Nextcloud, Syncthing, Dropbox, rclone and SMB/NFS.
- [ ] **T7 · A · Packages and VM matrix (Phase 7, L = 3).** On clean VMs (Ubuntu 24.04, Debian 13, Fedora, Arch, openSUSE Tumbleweed), each package must install, launch, become the default browser, update to the next build and uninstall. `chrome://sandbox` must show the namespace sandbox, including on Ubuntu with AppArmor on.
- [ ] **T8 · A · Accessibility and performance (Phase 8, M = 2).**
  - Orca across the UI and pages, and keyboard-only use.
  - Performance next to the Mac `scripts/perf` numbers: cold start, 50 tabs, frame times.

K during stage 2:

- [ ] **K6 · Fixes.** Fix failures D or A reports in K's areas, then ask the reporting developer to re-run the step.

A during stage 2:

- [ ] **A4 · CI (M = 2), previously K7.** An app build from the archived engine on every PR, and smoke launches in distro containers, on GitHub's Ubuntu runners. This needs no local Linux machine.

## Dependencies

| Waits               | On                                        | Why                                                                                                           |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Stage 2             | Every stage 1 item                        | Linux testing runs once, after all the code is written                                                        |
| T2–T8               | T1                                        | Linux runtime work needs a built engine                                                                       |
| T1 engine build     | K4                                        | The build needs the layer and branding patches                                                                |
| A3 final layout     | K4                                        | Binary name and paths; until then, use the names agreed up front                                              |
| K2 UI side          | K2 snapshot field in `nativeContracts.ts` | Agree the field before coding against it                                                                      |
| K8 data gate        | D1                                        | `bay/data` on Linux needs the BoringSSL sync backend to link                                                  |
| A4 CI               | T1                                        | CI builds the app from the archived engine                                                                    |
| Beta (Phase 8 exit) | T8 and A4                                 | Every Mac test script has a Linux CI run, and the prerelease channel has no known crash for one release cycle |

All three developers can start their stage 1 work in parallel using the agreed names above. K8 can implement readers and fixtures immediately; its final Linux link check waits for D1. K9 can use a fake secret backend independently of D1, and A3 uses fixture archives until T1 provides the real engine archive.
