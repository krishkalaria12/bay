"""Desktop frames replace the WebUI window native widget through one shared hook."""
import importlib.util
from pathlib import Path
import unittest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("frame_patch_series", REPO / "engine/patches/series.py")
series = importlib.util.module_from_spec(spec)
spec.loader.exec_module(series)
WEBUI = REPO / "engine/chromium/src/chrome/browser/bay/webui"


def added(patch):
    return "\n".join(line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++"))


class FrameHookTests(unittest.TestCase):
    def test_frame_hook_is_shared_by_web_desktops_and_follows_window_patches(self):
        names = [step.name for step in series.read_series("win")]
        self.assertIn("chromium-bay-native-widget.patch", names)
        self.assertNotIn("chromium-bay-native-widget.patch", {step.name for step in series.read_series("mac")})
        self.assertIn("chromium-bay-native-widget.patch", {step.name for step in series.read_series("linux")})
        # Its context is the WebUI window as the window and lifecycle patches leave it.
        for earlier in ("chromium-bay-webui-window.patch", "chromium-bay-lifecycle.patch"):
            self.assertLess(names.index(earlier), names.index("chromium-bay-native-widget.patch"))

    def test_hook_is_installed_before_profiles_create_windows(self):
        patch = added((REPO / "engine/patches/chromium-bay-native-widget.patch").read_text())
        self.assertIn("static void SetBayNativeWidgetFactory(", patch)
        self.assertIn("g_bay_native_widget_factory(widget_.get())", patch)
        self.assertNotIn('#include "chrome/browser/bay/', patch)
        delegate = (REPO / "engine/nncore/src/bay/core/nn_main_delegate_desktop.cc").read_text()
        hook = delegate[delegate.index("void PreProfileInit() override"):]
        self.assertIn("SetBayNativeWidgetFactory(\n        &bay::FrameWin::CreateNativeWidget)", hook[:hook.index("}")])

    def test_frame_builds_into_the_windows_services(self):
        build = (WEBUI / "BUILD.gn").read_text()
        windows = build[build.index('source_set("platform_services_win")'):]
        self.assertIn('"frame_win.cc"', windows)
        self.assertIn('"dwmapi.lib"', windows)


if __name__ == "__main__":
    unittest.main()
