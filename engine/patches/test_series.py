"""Portable patch routing and Linux layer installation regressions."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("bay_series_test", HERE / "series.py")
series = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(series)


class PlatformRoutingTests(unittest.TestCase):
    def test_linux_selects_shared_host_without_cef_or_windows_patches(self):
        selected = {step.name for step in series.read_series("linux")}
        for name in ("webui-window", "lifecycle", "extension-hooks"):
            self.assertIn(f"chromium-bay-{name}.patch", selected)
        self.assertFalse(any(name.startswith("cef-") or name.endswith("-win.patch") for name in selected))
        self.assertNotIn("chromium-safe-storage-name.patch", selected)
        self.assertIn("chromium-safe-storage-name-linux.patch", selected)
        self.assertNotIn("chromium-safe-storage-name-linux.patch", {step.name for step in series.read_series("win")})
        self.assertNotIn("chromium-bay-layer.patch", selected)
        self.assertEqual({step.name for step in series.read_series()},
                         set().union(*({step.name for step in series.read_series(target)}
                                       for target in ("mac", "win", "linux"))))

    def test_comma_lists_route_to_each_target_in_series_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("common", "host", "linux", "mac"):
                (root / f"{name}.patch").touch()
            (root / "series").write_text("chromium all common.patch\n"
                                         "chromium win,linux host.patch\n"
                                         "chromium linux linux.patch\n"
                                         "chromium mac mac.patch\n")
            with mock.patch.object(series, "HERE", directory):
                self.assertEqual([s.name for s in series.read_series("linux")],
                                 ["common.patch", "host.patch", "linux.patch"])
                self.assertEqual([s.name for s in series.read_series("win")],
                                 ["common.patch", "host.patch"])
                self.assertEqual([s.name for s in series.read_series("mac")],
                                 ["common.patch", "mac.patch"])

    def test_invalid_platform_lists_fail_before_applying(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "fixture.patch").touch()
            for platforms in ("win,", ",linux", "win,,linux", "all,linux", "win,win", "linxu"):
                with self.subTest(platforms=platforms), mock.patch.object(series, "HERE", directory):
                    (root / "series").write_text(f"chromium {platforms} fixture.patch\n")
                    with self.assertRaisesRegex(SystemExit, "invalid kind or platform"):
                        series.read_series("linux")
        with self.assertRaisesRegex(SystemExit, "unknown series platform"):
            series.read_series("linxu")

    def test_windows_linkage_and_shared_host_apply_without_windows_context_on_linux(self):
        names = ("chromium-bay-layer-win.patch", "chromium-bay-webui-window.patch")
        steps = {step.name: step for step in series.read_series("win") if step.name in names}
        # These are the pinned chrome_dll dependency anchors. Only the Windows
        # layer patch may edit this block; the Linux host has no chrome_dll.
        original = '\n'.join([
            '      "//chrome/browser:chrome_content_browser_client",',
            '      "//chrome/browser:chrome_process_singleton",',
            '      "//chrome/browser:process_singleton",',
            '      "//chrome/browser:startup_data",',
            '      "//chrome/browser/lifetime",',
            '      "//chrome/browser/win/isolated_browser:isolated_browser_support",', ''])
        with tempfile.TemporaryDirectory() as directory:
            chrome = Path(directory) / "chrome"
            chrome.mkdir()
            build = chrome / "BUILD.gn"
            build.write_text(original)
            self.assertIsNone(series.apply_step(steps[names[0]], directory))
            self.assertIn('"//chrome/browser/bay/webui:impl"', build.read_text())
            self.assertIn('"//bay/core"', build.read_text())
            self.assertNotIn(("chrome/BUILD.gn", False), steps[names[1]].paths())

    def test_linux_safe_storage_item_is_bays_own(self):
        step = next(s for s in series.read_series("linux") if s.name == "chromium-safe-storage-name-linux.patch")
        # The pinned non-Chrome-branded names, which every Chromium build shares.
        original = '\n'.join([
            '  static constexpr char kKeyName[] = "Chrome Safe Storage";',
            '  static constexpr char kAppName[] = "chrome";',
            '#else',
            '  static constexpr char kKWalletFolder[] = "Chromium Keys";',
            '  static constexpr char kKeyName[] = "Chromium Safe Storage";',
            '  static constexpr char kAppName[] = "chromium";',
            '#endif',
            '',
            '  void InitializeFreedesktopSecretService();', ''])
        with tempfile.TemporaryDirectory() as directory:
            header = Path(directory) / "components/os_crypt/async/browser/freedesktop_secret_key_provider.h"
            header.parent.mkdir(parents=True)
            header.write_text(original)
            self.assertIsNone(series.apply_step(step, directory))
            text = header.read_text()
            for name in ('kKWalletFolder[] = "Bay Keys"', 'kKeyName[] = "Bay Safe Storage"', 'kAppName[] = "bay"'):
                self.assertIn(name, text)
            self.assertNotIn('"Chromium', text)
            self.assertNotIn('"chromium"', text)
            self.assertTrue(series.is_applied(step, directory))

    def test_linux_nncore_copies_layer_without_mac_hooks_and_detects_drift(self):
        step = next(s for s in series.read_series("linux") if s.name == "engine/nncore")
        self.assertEqual(step.paths(), [("bay", True)])
        mac = next(s for s in series.read_series("mac") if s.name == "engine/nncore")
        self.assertGreater(len(mac.paths()), 1)
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(series.apply_step(step, directory))
            self.assertEqual([p.name for p in Path(directory).iterdir()], ["bay"])
            self.assertTrue(series.is_applied(step, directory))
            copied = Path(directory) / "bay/core/BUILD.gn"
            copied.write_text("drift\n")
            self.assertFalse(series.is_applied(step, directory))
            self.assertIsNone(series.apply_step(step, directory))
            self.assertTrue(series.is_applied(step, directory))


if __name__ == "__main__":
    unittest.main()
