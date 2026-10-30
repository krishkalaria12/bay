"""Verify the native-view check distinguishes Bay's WebUI windows and profile Browsers from broken native windows."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
COMPILER = shutil.which("clang++") or shutil.which("c++")
PATCH = HERE / "chromium-webui-post-tab-model.patch"
RELATIVE = Path("chrome/browser/ui/browser_window/internal/browser_window_features.cc")
ORIGINAL = """void BrowserWindowFeatures::InitPostTabModelConstruction(
    BrowserWindowInterface* interface) {
  auto* browser_view = BrowserView::GetBrowserViewForBrowser(interface);
  CHECK(browser_view);

  auto* browser = browser_view->browser();
"""
STUBS = """
#define CHECK(condition) do { if (!(condition)) throw 1; } while (false)
struct BrowserWindowInterface {
  enum Type { TYPE_NORMAL, TYPE_POPUP };
  bool native;
  bool webui;
  Type type = TYPE_NORMAL;
  Type GetType() const { return type; }
};
namespace webui_browser {
bool enabled = false;
bool IsWebUIBrowserEnabled() { return enabled; }
}
struct BrowserView {
  static BrowserView* GetBrowserViewForBrowser(BrowserWindowInterface* browser) {
    static BrowserView view;
    return browser->native ? &view : nullptr;
  }
  void* browser() { return this; }
};
struct WebUIBrowserWindow {
  static WebUIBrowserWindow* FromBrowser(BrowserWindowInterface* browser) {
    static WebUIBrowserWindow window;
    return browser->webui ? &window : nullptr;
  }
};
struct BrowserWindowFeatures {
  int native_initializations = 0;
  void InitPostTabModelConstruction(BrowserWindowInterface* interface);
};
"""
CHECK_WINDOWS = """
  CHECK(browser);
  ++native_initializations;
}
int main() {
  BrowserWindowFeatures features;
  BrowserWindowInterface webui{false, true};
  try { features.InitPostTabModelConstruction(&webui); }
  catch (...) { return 1; }
  if (features.native_initializations != 0) return 2;

  BrowserWindowInterface native{true, false};
  features.InitPostTabModelConstruction(&native);
  if (features.native_initializations != 1) return 3;

  // A Bay window's Browser for another profile (WebUI browser on).
  webui_browser::enabled = true;
  BrowserWindowInterface profile_browser{false, false};
  try { features.InitPostTabModelConstruction(&profile_browser); }
  catch (...) { return 5; }
  if (features.native_initializations != 1) return 6;

  BrowserWindowInterface broken_popup{false, false,
                                      BrowserWindowInterface::TYPE_POPUP};
  bool popup_failed = false;
  try { features.InitPostTabModelConstruction(&broken_popup); }
  catch (...) { popup_failed = true; }
  if (!popup_failed) return 7;

  webui_browser::enabled = false;
  BrowserWindowInterface broken_native{false, false};
  try { features.InitPostTabModelConstruction(&broken_native); }
  catch (...) { return 0; }
  return 4;
}
"""


@unittest.skipUnless(COMPILER, "requires a host C++ compiler")
class WebUIWindowTests(unittest.TestCase):
    def test_webui_is_allowed_native_is_initialized_and_missing_native_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / RELATIVE
            source.parent.mkdir(parents=True)
            source.write_text(ORIGINAL)

            def run():
                test, binary = root / "test.cc", root / "test.exe"
                test.write_text(STUBS + source.read_text() + CHECK_WINDOWS)
                subprocess.run([COMPILER, "-std=c++17", "-Werror", str(test), "-o", str(binary)],
                               check=True, capture_output=True)
                return subprocess.run([str(binary)], check=False).returncode

            self.assertEqual(run(), 1, "the original WebUI path must reproduce the CHECK failure")
            subprocess.run(["git", "apply", str(PATCH)], cwd=root, check=True, capture_output=True)
            subprocess.run(["git", "apply", "--check", "-R", str(PATCH)], cwd=root,
                           check=True, capture_output=True)
            self.assertEqual(run(), 0)


if __name__ == "__main__":
    unittest.main()
