"""Compile the patched browser-type helper with and without CEF-only members."""
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
COMPILER = shutil.which("clang++") or shutil.which("c++")
RELATIVE = Path("chrome/browser/ui/browser_window/internal/browser_window_features.cc")
HELPER = """// static
bool BrowserWindowFeatures::IsNormalBrowser(
    const BrowserWindowInterface* browser) {
  // CEF normal browsers have TYPE_POPUP.
  if (browser->GetType() == BrowserWindowInterface::Type::TYPE_POPUP &&
      browser->cef_delegate()) {
    return true;
  }
  return browser->GetType() == BrowserWindowInterface::Type::TYPE_NORMAL;
}

"""
INTERFACE = """
#define BUILDFLAG(flag) flag
struct BrowserWindowInterface {
  enum class Type { TYPE_NORMAL, TYPE_POPUP };
  Type type;
  bool has_delegate;
  Type GetType() const { return type; }
#if ENABLE_CEF
  bool cef_delegate() const { return has_delegate; }
#endif
};
struct BrowserWindowFeatures {
  static bool IsNormalBrowser(const BrowserWindowInterface* browser);
};
"""
CHECK_TYPES = """
int main() {
  using Type = BrowserWindowInterface::Type;
  for (bool has_delegate : {false, true}) {
    BrowserWindowInterface normal{Type::TYPE_NORMAL, has_delegate};
    if (!BrowserWindowFeatures::IsNormalBrowser(&normal)) return 1;
    BrowserWindowInterface popup{Type::TYPE_POPUP, has_delegate};
    if (BrowserWindowFeatures::IsNormalBrowser(&popup) !=
        (ENABLE_CEF && has_delegate)) return 2;
  }
  return 0;
}
"""


@unittest.skipUnless(COMPILER, "requires a host C++ compiler")
class CefOffTests(unittest.TestCase):
    def compile(self, root, helper, cef):
        source = root / "test.cc"
        source.write_text("#include <initializer_list>\n" + INTERFACE + helper + CHECK_TYPES)
        binary = root / "test.exe"
        result = subprocess.run([COMPILER, "-std=c++17", "-Werror", f"-DENABLE_CEF={cef}",
                                 str(source), "-o", str(binary)], capture_output=True, text=True)
        return result, binary

    def test_unguarded_helper_reproduces_missing_cef_delegate(self):
        with tempfile.TemporaryDirectory() as directory:
            result, _ = self.compile(Path(directory), HELPER, 0)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("cef_delegate", result.stderr)

    def test_patch_compiles_both_modes_and_preserves_browser_types(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / RELATIVE
            source.parent.mkdir(parents=True)
            source.write_text(HELPER)
            patch = HERE / "chromium-window-features-cef-off.patch"
            subprocess.run(["git", "apply", str(patch)], cwd=root, check=True, capture_output=True)
            subprocess.run(["git", "apply", "--check", "-R", str(patch)], cwd=root,
                           check=True, capture_output=True)
            for cef in (0, 1):
                with self.subTest(cef=cef):
                    result, binary = self.compile(root, source.read_text(), cef)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    subprocess.run([str(binary)], check=True)

    def test_runtime_views_patch_preserves_cef_on_and_removes_cef_off_calls(self):
        before, after = [], []
        for line in (HERE / "chromium-runtime-views-cef-off.patch").read_text().splitlines(True):
            if line.startswith(("diff ", "--- ", "+++ ", "@@")):
                continue
            if line.startswith((" ", "-")):
                before.append(line[1:])
            if line.startswith((" ", "+")):
                after.append(line[1:])

        def preprocess(lines, cef):
            result = subprocess.run([COMPILER, "-E", "-P", "-x", "c++", f"-DENABLE_CEF={cef}", "-"],
                                    input="#define BUILDFLAG(flag) flag\n" + "".join(lines),
                                    capture_output=True, text=True, check=True)
            return re.sub(r"\s+", "", result.stdout)

        self.assertEqual(preprocess(before, 1), preprocess(after, 1))
        cef_off = preprocess(after, 0)
        self.assertNotIn("cef::", cef_off)
        self.assertNotIn("toolbar_overridden", cef_off)
        self.assertNotIn("InitPostWindowConstruction", cef_off)
        self.assertIn("IsToolbarVisible()", cef_off)
        self.assertIn("DisplayMode::kNormal", cef_off)


if __name__ == "__main__":
    unittest.main()
