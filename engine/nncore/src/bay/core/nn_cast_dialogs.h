// Copyright 2026 Bay. Apache-2.0.
// Chrome's Cast dialog for a host's tabs goes to the app (JS CastDialog):
// Chrome's MediaRouterUI finds the sinks and casts, and the app shows them.
// Chrome's toolbar-anchored bubble has nothing to anchor to in Bay's windows.
// Both desktop hosts keep their dialogs here: macOS (nn_cast_dialog.mm) and
// Windows and Linux (webui/cast_dialogs.cc).
#ifndef BAY_CORE_NN_CAST_DIALOGS_H_
#define BAY_CORE_NN_CAST_DIALOGS_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}
namespace media_router {
class MediaRouterUI;
struct UIMediaSink;
}  // namespace media_router

namespace nncore::cast {

// Tells the app a dialog's state (JS CastDialog without browserId, which the
// host adds): false when nobody can use it, and an open dialog then closes.
using Tell =
    base::RepeatingCallback<bool(content::WebContents*, base::DictValue state)>;

// Later calls replace it.
void SetTell(Tell tell);

// Takes Chrome's dialog for |initiator|, told to the app on the next turn (not
// from inside Chrome's dialog creation: the app may close it at once).
void Adopt(content::WebContents* initiator, media_router::MediaRouterUI* ui);

// A dialog that has gone is ignored. |cast_mode| is a MediaCastMode bit (JS
// CastMode); anything else is refused.
bool StartCasting(int id, const std::string& sink, int cast_mode);
void StopCasting(int id, const std::string& route);
void Close(int id);

// A sink of the JS CastDialog.
base::DictValue DescribeSink(const media_router::UIMediaSink& sink);

}  // namespace nncore::cast

#endif  // BAY_CORE_NN_CAST_DIALOGS_H_
