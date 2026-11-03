// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DISPLAY_MEDIA_PICKER_H_
#define CHROME_BROWSER_BAY_WEBUI_DISPLAY_MEDIA_PICKER_H_

#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}
namespace bay {
class HostContext;

// Chrome owns request validation and capture. Bay replaces only the picker UI;
// selections must still be present in Chrome's policy-filtered source lists.
class DisplayMediaPicker {
 public:
  using Sink =
      base::RepeatingCallback<bool(content::WebContents*, base::DictValue)>;
  static void Start(Sink sink);
  static void SetEnabled(bool enabled);
  static base::ListValue Sources(const HostContext& context);
  static bool Resolve(content::WebContents* contents,
                      const std::string& request_id,
                      const std::optional<std::string>& source_id);
  // A parked or transferred tab no longer has the window that showed consent.
  static void CancelForContents(content::WebContents* contents);
  static std::string CaptureId(content::WebContents* contents);
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_DISPLAY_MEDIA_PICKER_H_
