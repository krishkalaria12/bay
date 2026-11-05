// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DEVICE_CHOOSERS_H_
#define CHROME_BROWSER_BAY_WEBUI_DEVICE_CHOOSERS_H_

#include <memory>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}
namespace permissions {
class ChooserController;
}

namespace bay {

// A page's device chooser (WebUSB, WebHID, Web Serial, Web Bluetooth
// requestDevice) in Bay's windows goes to the app (JS DeviceChooser), as macOS
// nn_device_chooser: Chrome's bubble anchors to a toolbar these windows don't
// have. Chrome's ChooserController keeps finding devices; the app shows them
// and answers.
class DeviceChoosers {
 public:
  // BayChromeUI.onDeviceChooser, to the window showing the tab: false when no
  // window does, and an open chooser is then cancelled.
  using Sink = base::RepeatingCallback<
      bool(content::WebContents*, const char* event, base::DictValue state)>;

  // Installs Chrome's hook (chromium-chrome-dialogs-webui.patch). Later calls
  // replace the sink.
  static void Start(Sink sink);

  // Takes a chooser for |contents|, told to the app on the next turn. Returns
  // its id; what closes it from Chrome's side is CloseFromChrome.
  static int Adopt(std::unique_ptr<permissions::ChooserController> controller,
                   content::WebContents* contents);
  static void CloseFromChrome(int id);

  // A chooser that has gone is ignored. A scanning prompt has no options: its
  // OK arrives as any index and allows it.
  static void Select(int id, int index);
  static void Cancel(int id);
  static void Refresh(int id);
  // Bluetooth's privacy settings, for the choosers that show that link.
  static void OpenSettings(int id);
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_DEVICE_CHOOSERS_H_
