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
    def test_crashpad_handler_patch_is_linux_only(self):
        name = "chromium-crashpad-handler-linux.patch"
        self.assertIn(name, {step.name for step in series.read_series("linux")})
        for platform in ("mac", "win"):
            self.assertNotIn(name, {step.name for step in series.read_series(platform)})

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

    def test_button_layout_portal_patch_is_linux_only(self):
        name = "chromium-window-button-layout-portal-linux.patch"
        self.assertIn(name, {step.name for step in series.read_series("linux")})
        for platform in ("mac", "win"):
            self.assertNotIn(name, {step.name for step in series.read_series(platform)})

    def test_linux_linking_and_branding_are_exclusive_and_follow_shared_branding(self):
        selected = [step.name for step in series.read_series("linux")]
        names = ("chromium-bay-layer-linux.patch", "chromium-bay-branding-linux.patch")
        for name in names:
            self.assertIn(name, selected)
            for platform in ("mac", "win"):
                self.assertNotIn(name, {step.name for step in series.read_series(platform)})
        self.assertLess(selected.index("chromium-branding.patch"), selected.index(names[1]))

    def test_linux_layer_links_browser_executable_and_preserves_helper_targets(self):
        step = next(s for s in series.read_series("linux") if s.name == "chromium-bay-layer-linux.patch")
        original = '\n'.join([
            'executable("chrome_initial") {',
            '    if (is_linux) {',
            '      sources += [',
            '        "app/chrome_main_linux.cc",',
            '        "app/chrome_main_linux.h",',
            '      ]',
            '    }',
            '',
            '    if (is_chrome_for_testing) {',
            '    }',
            '}',
            'group("chrome_sandbox") {}',
            'group("chrome_crashpad_handler") {}', ''])
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory) / "chrome/BUILD.gn"
            build.parent.mkdir()
            build.write_text(original)
            self.assertIsNone(series.apply_step(step, directory))
            text = build.read_text()
            for dependency in ("//bay/core", "//chrome/browser/bay:exports", "//chrome/browser/bay/webui:impl"):
                self.assertIn(f'"{dependency}"', text)
            self.assertTrue(text.endswith('group("chrome_sandbox") {}\ngroup("chrome_crashpad_handler") {}\n'))
            self.assertTrue(series.is_applied(step, directory))

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

    def test_shared_host_runs_nncore_and_keeps_empty_windows_on_linux(self):
        patch = (HERE / "chromium-bay-webui-window.patch").read_text()
        added = "\n".join(line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++"))
        # NNCore's main delegate, and with it the frame hook, runs on both web desktops.
        self.assertIn('#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)\n#include "bay/core/nn_main_delegate.h"', added)
        self.assertIn("#elif BUILDFLAG(IS_LINUX)\n  nncore::NNMainDelegate chrome_main_delegate(", added)
        # Every host gate, including the empty-strip ones that keep a parked
        # window open, covers Linux.
        self.assertNotIn("#if BUILDFLAG(IS_WIN)\n", added + "\n")

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


class AppliedDetectionTests(unittest.TestCase):
    """A step whose files a later step edits is still recognised, so a retried prepare skips it."""

    CREATE = "\n".join(["diff --git a/BRANDING b/BRANDING", "new file mode 100644", "--- /dev/null",
                        "+++ b/BRANDING", "@@ -0,0 +1,2 @@", "+NAME=Chromium", "+KEEP=1", ""])
    REWRITE = "\n".join(["diff --git a/BRANDING b/BRANDING", "--- a/BRANDING", "+++ b/BRANDING",
                         "@@ -1,2 +1,2 @@", "-NAME=Chromium", "+NAME=Bay", " KEEP=1", ""])
    OTHER = "\n".join(["diff --git a/other.txt b/other.txt", "new file mode 100644", "--- /dev/null",
                       "+++ b/other.txt", "@@ -0,0 +1 @@", "+new", ""])

    def steps(self, directory):
        patches = Path(directory) / "patches"
        patches.mkdir()
        steps = []
        for line, (name, text) in enumerate((("create.patch", self.CREATE), ("rewrite.patch", self.REWRITE),
                                              ("other.patch", self.OTHER)), 1):
            (patches / name).write_text(text)
            steps.append(series.Step("chromium", name, line))
        return patches, steps

    def test_step_rewritten_by_a_later_step_counts_as_applied(self):
        with tempfile.TemporaryDirectory() as directory:
            patches, (create, rewrite, other) = self.steps(directory)
            tree = Path(directory) / "tree"
            tree.mkdir()
            with mock.patch.object(series, "HERE", str(patches)):
                self.assertFalse(series.is_applied(create, str(tree), [rewrite, other]))
                for step in (create, rewrite):
                    self.assertIsNone(series.apply_step(step, str(tree)))
                # A plain reverse check fails: BRANDING no longer reads as create.patch left it.
                self.assertFalse(series.reverses(create, str(tree)))
                self.assertTrue(series.is_applied(create, str(tree), [rewrite, other]))
                self.assertTrue(series.is_applied(rewrite, str(tree), [other]))
                self.assertFalse(series.is_applied(other, str(tree)))
                # The scratch check leaves the tree alone.
                self.assertEqual((tree / "BRANDING").read_text(), "NAME=Bay\nKEEP=1\n")

    def test_created_file_with_other_contents_is_not_applied(self):
        with tempfile.TemporaryDirectory() as directory:
            patches, (create, rewrite, other) = self.steps(directory)
            tree = Path(directory) / "tree"
            tree.mkdir()
            (tree / "BRANDING").write_text("NAME=Elsewhere\nKEEP=0\n")
            with mock.patch.object(series, "HERE", str(patches)):
                self.assertFalse(series.is_applied(create, str(tree), [rewrite, other]))


if __name__ == "__main__":
    unittest.main()
