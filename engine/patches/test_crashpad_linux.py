"""Exercise the patched handler selection without linking Chromium or Crashpad."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
COMPILER = shutil.which("clang++") or shutil.which("c++")
PATCH = HERE / "chromium-crashpad-handler-linux.patch"

STUBS = r"""
#include <algorithm>
#include <string>
#include <vector>
#define BUILDFLAG(flag) flag
#define DCHECK(condition) do { if (!(condition)) return false; } while (false)
namespace base {
constexpr int DIR_EXE = 1;
struct FilePath {
  std::string value;
  bool empty() const { return value.empty(); }
  FilePath Append(const char* name) const { return {value + "/" + name}; }
};
struct PathService {
  static bool Get(int key, FilePath* result) {
    result->value = key == DIR_EXE ? "/opt/bay" : "/opt/bay/bay";
    return true;
  }
};
}
namespace content { constexpr int CHILD_PROCESS_EXE = 2; }
namespace switches { constexpr char kCrashpadHandler[] = "crashpad-handler"; }
struct CrashReporterClient {
  void GetCrashOptionalArguments(std::vector<std::string>* args) {
    args->push_back("--test-optional");
  }
};
"""


def patch_images():
    """Reconstruct only touched contexts so the test applies the real patch."""
    before, after = {}, {}
    relative = None
    for line in PATCH.read_text().splitlines(True):
        if line.startswith("+++ b/"):
            relative = line[6:].strip()
            before[relative], after[relative] = [], []
        elif not line.startswith(("diff ", "--- ", "@@")) and relative:
            if line.startswith((" ", "-")):
                before[relative].append(line[1:])
            if line.startswith((" ", "+")):
                after[relative].append(line[1:])
    return {p: "".join(lines) for p, lines in before.items()}


def program(text):
    path_setup = text.split("    crash_reporter_client->GetCrashMetricsLocation(&metrics_path);\n\n", 1)[1]
    path_setup = path_setup.split("    // When --use-cros-crash-reporter", 1)[0]
    mode_comment = text.index("    // Since we're using the same main")
    argument_setup = text[text.rfind("\n\n", 0, mode_comment) + 2:]
    argument_setup = argument_setup.split("    CHECK(client.StartHandler", 1)[0]
    return STUBS + "\nint main() {\n" + """
  CrashReporterClient reporter;
  auto* crash_reporter_client = &reporter;
  std::vector<std::string> arguments;
  auto configure = [&]() -> bool {
""" + path_setup + argument_setup + """
    const std::string expected_path = ENABLE_CEF ? "/opt/bay/bay"
        : "/opt/bay/chrome_crashpad_handler";
    const bool has_type = std::find(arguments.begin(), arguments.end(),
        "--type=crashpad-handler") != arguments.end();
    const bool has_optional = std::find(arguments.begin(), arguments.end(),
        "--test-optional") != arguments.end();
    return handler_path.value == expected_path && has_type == bool(ENABLE_CEF)
        && has_optional;
  };
  return configure() ? 0 : 1;
}
"""


@unittest.skipUnless(COMPILER, "requires a host C++ compiler")
class CrashpadHandlerTests(unittest.TestCase):
    def test_handler_protocol_matches_cef_mode_and_patch_reapplies_safely(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            before = patch_images()
            for relative, text in before.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            source_path = root / "components/crash/core/app/crashpad_linux.cc"
            source, binary = root / "test.cc", root / "test.exe"

            def run(cef):
                source.write_text(program(source_path.read_text()))
                subprocess.run([COMPILER, "-std=c++17", "-Werror", f"-DENABLE_CEF={cef}",
                                str(source), "-o", str(binary)], check=True, capture_output=True)
                return subprocess.run([str(binary)], check=False).returncode

            # The unpatched CEF variant wrongly launches the browser in a
            # non-CEF build. Its legitimate CEF embedding protocol works.
            self.assertEqual(run(0), 1)
            self.assertEqual(run(1), 0)
            subprocess.run(["git", "apply", str(PATCH)], cwd=root, check=True, capture_output=True)
            subprocess.run(["git", "apply", "--check", "-R", str(PATCH)], cwd=root,
                           check=True, capture_output=True)
            self.assertEqual(run(0), 0)
            self.assertEqual(run(1), 0)


if __name__ == "__main__":
    unittest.main()
