// Copyright 2026 Bay. Apache-2.0.
// A page's device chooser (WebUSB, WebHID, Web Serial, Web Bluetooth
// requestDevice) in a host's tabs goes to the app (JS DeviceChooser): Chrome's
// bubble anchors to a toolbar Bay's windows don't have. Chrome's
// ChooserController keeps finding devices; the app shows them and answers.
// Both desktop hosts keep their choosers here: macOS (nn_device_chooser.mm) and
// Windows and Linux (webui/device_choosers.cc).
#ifndef BAY_CORE_NN_DEVICE_CHOOSERS_H_
#define BAY_CORE_NN_DEVICE_CHOOSERS_H_

#include <memory>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}
namespace permissions {
class ChooserController;
}

namespace nncore::choosers {

// Tells the app a chooser's state (JS DeviceChooser without browserId, which
// the host adds): false when nobody can answer, and an open chooser is then
// cancelled so the page hears a refusal rather than waiting for ever.
using Tell =
    base::RepeatingCallback<bool(content::WebContents*, base::DictValue state)>;

// Later calls replace it.
void SetTell(Tell tell);

// Takes a chooser for |contents|, told to the app on the next turn (not from
// inside Chrome's request: the app may answer at once). Returns its id.
int Adopt(std::unique_ptr<permissions::ChooserController> controller,
          content::WebContents* contents);

// The page's request went (navigation, the tab closing).
void CloseFromChrome(int id);

// A chooser that has gone is ignored. A scanning prompt has no options: its OK
// arrives as any index and allows it.
void Select(int id, int index);
void Cancel(int id);
void Refresh(int id);

// Bluetooth's privacy settings (Chrome's "authorize Bluetooth" link): only the
// choosers that show that link have them (Bluetooth, Serial); the others'
// implementation is NOTREACHED().
bool OffersSettings(int id);
void OpenSettings(int id);

// An open chooser's controller (a test drives it as an adapter would).
permissions::ChooserController* Controller(int id);

}  // namespace nncore::choosers

#endif  // BAY_CORE_NN_DEVICE_CHOOSERS_H_
