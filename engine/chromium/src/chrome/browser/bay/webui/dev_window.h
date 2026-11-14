// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DEV_WINDOW_H_
#define CHROME_BROWSER_BAY_WEBUI_DEV_WINDOW_H_

#include <optional>
#include <string>
#include <string_view>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/dev_window_input.h"

class BrowserWindowInterface;

namespace bay {
class HostContext;

// The test harness's hooks (BayApp.dev* in AppModule.swift), on the desktop
// host. Each needs an isolated BAY_DATA_DIR instance, as macOS's need a DEBUG
// build.
bool DevHarnessAllowed();
// A Bay window by its app id, or "key" for the active one, that `context` may
// drive: a window's document only its own, the coordinator any.
BrowserWindowInterface* DevHarnessFrame(const HostContext& context,
                                        const std::string& window_id);
// The window as it is on screen, frame and pages, as a PNG at `path`: on the
// window's background, or `transparent` keeping what shows through as alpha.
void DevSnapshotWindow(BrowserWindowInterface* frame,
                       const base::FilePath& path,
                       bool transparent,
                       base::OnceCallback<void(bool)> done);
// Moves keyboard focus to the window's "window" document, its "page" or that
// page's docked "devtools", as macOS's first responder. False without one.
bool DevFocus(BrowserWindowInterface* frame, std::string_view target);
// Each character as a key, `interval` ms apart, as the platform delivers keys.
// Answers [{due, handled, drawn}] in ms since the epoch: when the key was due,
// sent, and the next frame reached the screen.
void DevTypeKeys(BrowserWindowInterface* frame,
                 const std::u16string& text,
                 double interval,
                 base::OnceCallback<void(base::Value)> done);
// A "keys:" action's key down, to report what it matched; `send` sends it.
std::optional<DevKeyStep> DevPressKey(BrowserWindowInterface* frame,
                                      const std::string& action,
                                      bool send);

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
