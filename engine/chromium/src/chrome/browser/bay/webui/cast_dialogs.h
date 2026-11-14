// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CAST_DIALOGS_H_
#define CHROME_BROWSER_BAY_WEBUI_CAST_DIALOGS_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}
namespace media_router {
struct UIMediaSink;
}

namespace bay {

// Chrome's Cast dialog in Bay's windows goes to the app (JS CastDialog), as
// macOS nn_cast_dialog: Chrome's MediaRouterUI finds the sinks and casts, and
// the app shows them. Chrome's toolbar-anchored bubble has nothing to anchor to
// in these windows.
class CastDialogs {
 public:
  // BayChromeUI.onCastDialog, to the window showing the tab: false when no
  // window does, and an open dialog is then closed.
  using Sink = base::RepeatingCallback<
      bool(content::WebContents*, const char* event, base::DictValue state)>;

  // Installs Chrome's hooks (chromium-chrome-dialogs-webui.patch). Later calls
  // replace the sink.
  static void Start(Sink sink);

  // A dialog that has gone is ignored. |cast_mode| is a MediaCastMode bit (JS
  // CastMode); anything else is refused.
  static bool StartCasting(int id, const std::string& sink, int cast_mode);
  static void StopCasting(int id, const std::string& route);
  static void Close(int id);

  // A sink of the JS CastDialog.
  static base::DictValue DescribeSink(const media_router::UIMediaSink& sink);
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_CAST_DIALOGS_H_
