"""Compile the patched WebUI network policy and preserve its origin boundary."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
COMPILER = shutil.which("clang++") or shutil.which("c++")
PATCH = HERE / "chromium-bay-webui-network.patch"
RELATIVE = Path("chrome/browser/ui/webui/chrome_web_ui_controller_factory.cc")
ORIGINAL = """#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/content_client.h"
#include "content/public/common/url_utils.h"
#include "crypto/crypto_buildflags.h"
#include "extensions/buildflags/buildflags.h"

// static
bool ChromeWebUIControllerFactory::IsWebUIAllowedToMakeNetworkRequests(
    const url::Origin& origin) {
  // Allowlist to work around exceptional cases.
  //
  // If you are adding a new host to this list, please file a corresponding bug
  // to track its removal. See https://crbug.com/40091019 for the metabug.
  return
      // https://crbug.com/40571286
      origin.host() == chrome::kChromeUISyncConfirmationHost ||
      // https://crbug.com/41382586
      origin.host() == chrome::kChromeUIInspectHost ||
      // https://crbug.com/40583261
      origin.host() == chrome::kChromeUIDownloadsHost ||
      // https://crbug.com/376417346
      origin.host() == chrome::kChromeUIExtensionsHost ||
      // https://crbug.com/509216218
      origin.host() == chrome::kChromeUIDrivePickerHostHost;
}
"""
STUBS = r"""
#include <string_view>
namespace url {
struct Origin {
  std::string_view scheme_, host_;
  std::string_view scheme() const { return scheme_; }
  std::string_view host() const { return host_; }
};
}
namespace content { constexpr auto kChromeUIScheme = "chrome"; }
namespace chrome {
constexpr auto kChromeUISyncConfirmationHost = "sync-confirmation";
constexpr auto kChromeUIInspectHost = "inspect";
constexpr auto kChromeUIDownloadsHost = "downloads";
constexpr auto kChromeUIExtensionsHost = "extensions";
constexpr auto kChromeUIDrivePickerHostHost = "drive-picker-host";
}
struct ChromeWebUIControllerFactory {
  static bool IsWebUIAllowedToMakeNetworkRequests(const url::Origin& origin);
};
"""
CHECK_POLICY = r"""
int main() {
  auto allowed = ChromeWebUIControllerFactory::IsWebUIAllowedToMakeNetworkRequests;
  if (!allowed({"chrome", "bay"})) return 1;
  for (const auto& origin : {url::Origin{"https", "bay"},
                            url::Origin{"chrome-untrusted", "bay"},
                            url::Origin{"chrome", "bay.evil"},
                            url::Origin{"chrome", "webui-browser"},
                            url::Origin{"chrome", "settings"}}) {
    if (allowed(origin)) return 2;
  }
  for (const auto host : {chrome::kChromeUISyncConfirmationHost,
                          chrome::kChromeUIInspectHost,
                          chrome::kChromeUIDownloadsHost,
                          chrome::kChromeUIExtensionsHost,
                          chrome::kChromeUIDrivePickerHostHost}) {
    if (!allowed({"chrome", host})) return 3;
  }
  return 0;
}
"""


@unittest.skipUnless(COMPILER, "requires a host C++ compiler")
class WebUINetworkTests(unittest.TestCase):
    def test_only_trusted_bay_gains_network_access_and_existing_hosts_stay_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / RELATIVE
            source.parent.mkdir(parents=True)
            source.write_text(ORIGINAL)

            def run():
                function = source.read_text().split("// static\n", 1)[1]
                test, binary = root / "test.cc", root / "test"
                test.write_text(STUBS + function + CHECK_POLICY)
                subprocess.run([COMPILER, "-std=c++17", "-Werror", str(test), "-o", str(binary)],
                               check=True, capture_output=True)
                return subprocess.run([str(binary)], check=False).returncode

            self.assertEqual(run(), 1, "the original policy withholds Bay's network factory")
            subprocess.run(["git", "apply", str(PATCH)], cwd=root, check=True, capture_output=True)
            subprocess.run(["git", "apply", "--check", "-R", str(PATCH)], cwd=root,
                           check=True, capture_output=True)
            self.assertEqual(run(), 0)


if __name__ == "__main__":
    unittest.main()
