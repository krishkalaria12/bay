// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DEV_WINDOW_H_
#define CHROME_BROWSER_BAY_WEBUI_DEV_WINDOW_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace bay {
class HostContext;

// Developer diagnostics use Chrome's frame session ids on the desktop host.
// Window renderers can inspect/control only their frame; the coordinator can
// address every Bay frame. Mutations require an isolated BAY_DATA_DIR instance.
class DevWindow {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  // Handles chromeWindows, devWindowNumber and devWindow. Unknown methods do
  // not consume the callback, so the normal facade dispatcher can continue.
  static bool Dispatch(const HostContext& context,
                       const std::string& method,
                       const base::ListValue& args,
                       Response& response);
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_DEV_WINDOW_H_
