# Engine CLI

Use `python scripts/engine.py --platform win|linux COMMAND` for `pin`, `download`,
`prepare`, `build`, `archive`, or `all`. The default platform is `win`.
`scripts/windows/engine.py` remains a compatible Windows entry point, including
its imported artifact helpers. macOS keeps its existing build scripts.

```sh
python scripts/engine.py --platform linux pin
python scripts/engine.py --platform linux download --root "$HOME/chromium-build"
```

`pin` runs on any host. Other commands require the selected native OS; Linux
also requires an x64 host. The default roots are `C:/bay-engine` for Windows and
`~/chromium-build` for Linux. `--root` overrides `BAY_ENGINE_ROOT`, which overrides
the default. Keep a separate root for each platform. Existing checkouts are never
reset, and a root lock prevents concurrent driver commands.

Source revisions are shared in `engine/patches/build/engine-lock.json`;
`platforms.win` and `platforms.linux` hold platform settings. Artifact manifests
contain the shared pins merged with the selected platform's settings.

Linux linking and branding sources are implemented. The selected series links
Bay and NNCore into the browser executable, names it `bay`, and uses `bay.desktop`
and `/etc/bay` native-messaging and policy paths. NNCore retains its canonical
`$XDG_CONFIG_HOME/Bay` (or `~/.config/Bay`) profile directory; Chromium's unused
default-directory fallback is branded `bay`.
`chrome_sandbox` and `chrome_crashpad_handler` keep their upstream names. The
shared host patch runs NNCore's desktop main delegate on Linux; the Linux window
identity patch supplies the launch token, X11 class and Wayland app id.

After syncing, install the pinned Chromium tree's build dependencies and finish
depot_tools setup manually. Preparation and builds verify that the integration
patches are selected and the locked Debian Bullseye amd64 sysroot is installed.
The lock identifies the sysroot archive by SHA-256 and its pinned Chromium
metadata; preflight checks that metadata and a matching installer or gclient
receipt. GN explicitly uses the locked sysroot directory. The driver requires relevant tools on PATH;
it does not invoke sudo or install host packages. Per `linux-work-split.md`, actual
Linux preparation, GN generation and builds wait until stage 2.

Preparation retains the CEF Chromium compatibility baseline, applies ungoogled
patches and domain substitution, then captures/applies the selected Chromium
series and generates GN files. CEF is disabled in GN. Linux adds `use_sysroot`,
`use_vaapi`, and `rtc_use_pipewire`. The default targets are `chrome` on Windows
and `chrome chrome_sandbox` on Linux. `--target NAME` can repeat to override the
defaults; `--jobs N` sets positive build concurrency.
Linux also selects ungoogled's sandbox PIE patch and removal of
`--disable-setuid-sandbox` from the bad-flags warning; other hosts skip both.
This does not disable the sandbox. A3 supplies the `/opt/bay` installation tree,
desktop entry, wrapper and AppArmor policy.

`archive --output DIR` requires a successful build stamp matching the current
source digest and platform lock. Windows keeps its runtime ZIP and PDB symbols
ZIP. Linux expects a branded `bay` ELF executable, `chrome_sandbox`,
`chrome_crashpad_handler`, resources, locales, and generated Mojo bindings. It
requires `zstd`, `readelf`, `objcopy`, and `strip`. It creates runtime and symbols
`.tar.zst` files with SHA-256 sidecars, extracts debug information from ELF copies,
and hashes the packaged runtime files. Required executables must have debug
information. Prebuilt libraries without debug information are copied unchanged.
The source build outputs remain intact. Sandbox setuid permissions are removed
from the archive; installation policy is separate.

Linux archive tests use fixtures and mocked native tools. The sysroot archive
identity is pinned from source metadata; it is not a measurement of the built
engine's ABI requirements. No successful Linux engine build, desktop smoke test
or glibc floor has been established. `minimumGlibc` remains `null`, so the lock
makes no distro compatibility promise. K4's changed native files have partial
Linux x64 release/DCHECK syntax coverage using generated Mac configuration
headers; `chrome_paths.cc` is blocked by their CEF-enabled policy-path enum, and
`webui_browser_window.cc` by missing Linux Mojo types in the generated headers.
These checks do not establish the Linux GN graph or linkage.

Portable regression checks:

```sh
python -m unittest discover -s scripts/windows -p 'test_*.py' -v
python -m unittest discover -s scripts -p 'test_engine_driver.py' -v
python -m unittest discover -s engine/patches -p 'test_*.py' -v
python -m unittest discover -s engine/chromium -p 'test_*.py' -v
```

K8's stage 1 Linux import fixtures also run on macOS:

```sh
python3 scripts/linux/test-import.py # Mac, including NSS fixture generation
# Linux or Mac, without the Mac-only NSS generator:
python3 scripts/linux/test-import.py --services-only
python3 packages/sync/linux/tests/service-test.py
bash packages/sync/scripts/check-linux-crypto.sh
python3 packages/sync/linux/tests/recovery-kit-test.py
python3 scripts/windows/test-native.py
```

The first command needs Homebrew OpenSSL, NSS/NSPR and GLib/GIO with
`pkg-config`. It compiles disposable fixture executables for Linux profile
discovery, import consent/cache behavior, native data envelopes, fake libsecret
and KWallet protocols, CBC formats and NSS `key4.db` reading. The NSS fixture
keeps another initialized profile alive to check isolation. It never opens a
real browser profile or keyring, configures GN, or builds/runs a Linux binary.
The sync service fixture compiles the Linux crypto and key-store policy with a fake
Secret Service, including session-only recovery and stale export refusal. On macOS
it uses explicit Linux test defines and produces a Mac executable. The crypto check
uses OpenSSL by default; set `BORINGSSL_ROOT` and `BORINGSSL_CRYPTO_LIBRARY` to test
the pinned production library. The final command checks shared reader and sync
compatibility fixtures. Linux sync advertisement, coordinator authority, UI dispatch
and password-reader wiring are source-complete. The browser supplies its current
OSCrypt encryptor, including desktop v11 and portal v12 providers; absent keys
produce an incomplete read rather than deleting synced passwords. CI runs the
services-only data facade fixtures on Linux, including fake desktop/portal providers.
Full native linking and real desktop keyring/picker execution remain unverified.

Verification on 26 Oct 2026 also generated a scratch Linux x64 GN graph for the
affected data/WebUI targets, passed their header dependency checks, and built the
generated `native_host.mojom-webui.js` resource. Thirteen host, test and data source
units passed Linux x64 release and DCHECK syntax checks with the pinned sysroot
and existing Mac-generated configuration headers. These checks establish the
affected graph and source compatibility, not a linked Linux browser or executed
native UI tests. Portable fixture execution and the web build/typechecks passed;
live keyring, portal and picker behavior still need a Linux desktop.

Once the Linux engine tree is prepared and GN-generated, build and run the
native helper tests on Linux:

```sh
autoninja -C out/Release_GN_x64 \
  chrome/browser/bay:pip_platform_unittests \
  chrome/browser/bay:external_apps_linux_unittests \
  chrome/browser/bay/webui:runtime_unittests \
  chrome/browser/bay/webui:page_security_unittests \
  chrome/browser/bay/webui:shell_ui_options_unittests \
  chrome/browser/bay/webui:notifications_unittests \
  chrome/browser/bay/webui:native_host_unittests \
  chrome/browser/bay/webui:sync_ui_linux_unittests \
  chrome/browser/bay/webui:frame_linux_unittests \
  chrome/browser/bay/webui:window_button_layout_linux_unittests \
  chrome/browser/bay/webui:quit_shortcut_linux_unittests \
  chrome/browser/bay/webui:secret_storage_linux_unittests \
  chrome/browser/bay/webui:keychain_unittests \
  chrome/browser/bay/webui:document_store_unittests \
  chrome/browser/bay/webui:shell_files_unittests \
  chrome/browser/bay/webui:shell_appearance_unittests \
  chrome/browser/bay/webui:shell_clipboard_unittests \
  chrome/browser/bay/webui:default_browser_unittests \
  chrome/browser/bay/webui:autostart_linux_unittests \
  chrome/browser/bay/webui:app_services_linux_unittests \
  chrome/browser/bay/webui:window_placement_unittests
for test in pip_platform_unittests external_apps_linux_unittests runtime_unittests page_security_unittests shell_ui_options_unittests notifications_unittests native_host_unittests sync_ui_linux_unittests frame_linux_unittests window_button_layout_linux_unittests quit_shortcut_linux_unittests secret_storage_linux_unittests keychain_unittests document_store_unittests shell_files_unittests shell_appearance_unittests shell_clipboard_unittests default_browser_unittests autostart_linux_unittests app_services_linux_unittests window_placement_unittests; do
  out/Release_GN_x64/$test || break
done
```

Run the fake-backend keychain suite repeatedly to check task-environment resets and request ordering:

```sh
out/Release_GN_x64/keychain_unittests --gtest_shuffle --gtest_repeat=3
```

With GTK and D-Bus enabled, also run the patched portal-layout tests during stage 2:

```sh
autoninja -C out/Release_GN_x64 ui/gtk:gtk_unittests
xvfb-run -a out/Release_GN_x64/gtk_unittests --gtest_filter='WindowButtonLayoutPortalTest.*'
```

These test targets are added but have not run. Current source checks use the
pinned Linux sysroot and generated Mac configuration headers. They do not prove
the Linux GN dependency graph, startup integration, or desktop behavior.
