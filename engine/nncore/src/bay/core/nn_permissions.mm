// The macOS host's side of the shared permission prompts (nn_permission_prompts.cc): the
// host's tabs, its delegate, and the test runs' system permissions and media devices.

#include "bay/core/nn_permissions.h"

#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/strings/sys_string_conversions.h"
#include "base/values.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "content/public/browser/web_contents.h"
#include "bay/core/nn_browser.h"
#include "bay/core/nn_fake_media.h"
#include "bay/core/nn_mac_values.h"
#include "bay/core/nn_permission_prompts.h"
#include "bay/core/nn_test_system_permissions.h"

namespace nncore {

void InstallPermissionPrompts() {
  MaybeInstallTestSystemPermissions();
  InstallFakeMediaDevices();
  permission_prompts::Host host;
  // The host's tabs only; Chrome's own windows keep Chrome's bubble.
  host.holds = base::BindRepeating([](content::WebContents* contents) {
    BrowserWindowInterface* browser =
        GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
    return browser && WindowHost::ForBrowser(browser);
  });
  host.ask = base::BindRepeating([](content::WebContents* contents, base::DictValue request) {
    HostPermissionRequest(contents, NSDictionaryFrom(request));
  });
  // The host closes a request it answered itself.
  host.gone = base::BindRepeating([](const std::string& id, bool answered) {
    if (!answered) {
      HostPermissionRequestDismissed(base::SysUTF8ToNSString(id));
    }
  });
  permission_prompts::Install(std::move(host));
}

void ResolvePermission(const std::string& request_id,
                       const std::string& result,
                       bool remember) {
  permission_prompts::Resolve(request_id, result, remember);
}

}  // namespace nncore
