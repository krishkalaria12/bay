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

    def test_linux_windows_carry_desktop_identity_after_the_frame_hook(self):
        name = "chromium-bay-window-identity-linux.patch"
        names = [step.name for step in series.read_series("linux")]
        self.assertLess(names.index("chromium-bay-native-widget.patch"), names.index(name))
        for platform in ("mac", "win"):
            self.assertNotIn(name, {step.name for step in series.read_series(platform)})
        patch = added((REPO / "engine/patches" / name).read_text())
        # The second Linux block configures the widget; the first includes its helper.
        linux = patch[patch.rindex("#if BUILDFLAG(IS_LINUX)"):patch.rindex("#endif")]
        self.assertIn("params.startup_id =\n      BrowserInitState::From(browser_)->create_params().startup_id;", linux)
        # The desktop matches Bay's windows to its desktop file, as Chrome's own windows.
        self.assertIn("params.wayland_app_id = params.wm_class_class;", linux)
        self.assertIn("shell_integration_linux::GetProgramClassName()", linux)
        # The frame reports X11 launch feedback complete once its window shows.
        frame = (WEBUI / "frame_linux.cc").read_text()
        self.assertIn("new WindowTreeHost(GetWidget(), this, params.startup_id)", frame)
        show = frame[frame.index("void Show(ui::mojom::WindowShowState show_state,"):]
        self.assertLess(show.index("DesktopWindowTreeHostLinux::Show("), show.index("NotifyStartupComplete(startup_id_)"))
        # An absorbed launch window never shows; its token focuses the Bay window instead.
        registry = (WEBUI / "window_registry.cc").read_text()
        absorb = registry[registry.index("void WindowRegistry::MoveIntoBayWindow("):]
        self.assertLess(absorb.index("base::nix::SetActivationToken(token)"), absorb.index("target->GetWindow()->Activate()"))

    def test_hook_is_installed_before_profiles_create_windows(self):
        patch = added((REPO / "engine/patches/chromium-bay-native-widget.patch").read_text())
        self.assertIn("static void SetBayNativeWidgetFactory(", patch)
        self.assertIn("g_bay_native_widget_factory(widget_.get())", patch)
        self.assertNotIn('#include "chrome/browser/bay/', patch)
        delegate = (REPO / "engine/nncore/src/bay/core/nn_main_delegate_desktop.cc").read_text()
        hook = delegate[delegate.index("void PreProfileInit() override"):]
        hook = hook[:hook.index("}")]
        for platform, frame in (("IS_WIN", "FrameWin"), ("IS_LINUX", "FrameLinux")):
            branch = hook[hook.index(f"#if BUILDFLAG({platform})"):]
            branch = branch[:branch.index("#endif")]
            self.assertIn(f"SetBayNativeWidgetFactory(\n        &bay::{frame}::CreateNativeWidget)", branch)

    def test_frame_builds_into_the_windows_services(self):
        build = (WEBUI / "BUILD.gn").read_text()
        windows = build[build.index('source_set("platform_services_win")'):]
        self.assertIn('"frame_win.cc"', windows)
        self.assertIn('"dwmapi.lib"', windows)

    def test_linux_frame_builds_alone_and_links_into_nncore(self):
        build = (WEBUI / "BUILD.gn").read_text()
        linux = build[build.index('source_set("frame_linux")'):]
        self.assertIn('"frame_linux.cc"', linux[:linux.index("}")])
        self.assertNotIn('"frame_linux.cc"', build[build.index('source_set("platform_services_win")'):build.index('source_set("frame_linux")')])
        nncore = (REPO / "engine/nncore/src/bay/core/BUILD.gn").read_text()
        branch = nncore[nncore.rindex("if (is_linux) {"):]
        self.assertIn('"//chrome/browser/bay/webui:frame_linux"', branch)

    def test_linux_frame_replaces_the_system_and_views_captions(self):
        frame = (WEBUI / "frame_linux.cc").read_text()
        self.assertIn("params.remove_standard_frame = true;", frame)
        self.assertIn("std::unique_ptr<views::FrameView> CreateFrameView() override", frame)
        self.assertIn("class ClientFrame final : public views::FrameViewLinux", frame)
        self.assertIn("void CreateCaptionButtons() override {}", frame)
        # Resize edges are tested before the client's CSS drag regions.
        hit = frame[frame.index("int NonClientHitTest("):]
        self.assertLess(hit.index("if (top || bottom || left || right)"),
                        hit.index("widget->client_view()->NonClientHitTest("))
        self.assertNotIn("windows.h", frame)


if __name__ == "__main__":
    unittest.main()
