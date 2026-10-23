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

Linux preparation and builds currently fail until the series routes
`chromium-bay-layer-linux.patch` and `chromium-bay-branding-linux.patch`. These
patches and Linux native host implementation are separate work. A source download
can run before those integrations exist. After syncing, install the pinned
Chromium tree's build dependencies and finish depot_tools setup manually. The
driver requires Chromium's Debian amd64 sysroot and the relevant tools on PATH;
it does not invoke sudo or install host packages.

Preparation retains the CEF Chromium compatibility baseline, applies ungoogled
patches and domain substitution, then captures/applies the selected Chromium
series and generates GN files. CEF is disabled in GN. Linux adds `use_sysroot`,
`use_vaapi`, and `rtc_use_pipewire`. The default targets are `chrome` on Windows
and `chrome chrome_sandbox` on Linux. `--target NAME` can repeat to override the
defaults; `--jobs N` sets positive build concurrency.

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

Linux archive tests use fixtures and mocked native tools. No successful Linux
engine build, desktop smoke test, sysroot revision measurement, or glibc floor
has been established by this groundwork. The Linux lock records unknown values
as `null`, so it makes no distro compatibility promise.

Portable regression checks:

```sh
python -m unittest discover -s scripts/windows -p 'test_*.py' -v
python -m unittest discover -s scripts -p 'test_engine_driver.py' -v
python -m unittest discover -s engine/chromium -p 'test_*.py' -v
```

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
  chrome/browser/bay/webui:frame_linux_unittests \
  chrome/browser/bay/webui:window_button_layout_linux_unittests \
  chrome/browser/bay/webui:secret_storage_linux_unittests \
  chrome/browser/bay/webui:document_store_unittests \
  chrome/browser/bay/webui:shell_files_unittests \
  chrome/browser/bay/webui:shell_appearance_unittests \
  chrome/browser/bay/webui:shell_clipboard_unittests \
  chrome/browser/bay/webui:default_browser_unittests \
  chrome/browser/bay/webui:autostart_linux_unittests \
  chrome/browser/bay/webui:app_services_linux_unittests \
  chrome/browser/bay/webui:window_placement_unittests
for test in pip_platform_unittests external_apps_linux_unittests runtime_unittests page_security_unittests shell_ui_options_unittests notifications_unittests native_host_unittests frame_linux_unittests window_button_layout_linux_unittests secret_storage_linux_unittests document_store_unittests shell_files_unittests shell_appearance_unittests shell_clipboard_unittests default_browser_unittests autostart_linux_unittests app_services_linux_unittests window_placement_unittests; do
  out/Release_GN_x64/$test || break
done
```

With GTK and D-Bus enabled, also run the patched portal-layout tests during stage 2:

```sh
autoninja -C out/Release_GN_x64 ui/gtk:gtk_unittests
xvfb-run -a out/Release_GN_x64/gtk_unittests --gtest_filter='WindowButtonLayoutPortalTest.*'
```

These test targets are added but have not run. Current source checks use the
pinned Linux sysroot and generated Mac configuration headers. They do not prove
the Linux GN dependency graph, startup integration, or desktop behavior.
