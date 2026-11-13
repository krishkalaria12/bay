// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_LIFECYCLE_EVENTS_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_LIFECYCLE_EVENTS_H_

#include <string_view>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}
namespace bay {

class PageLifecycleEvents {
 public:
  using ViewSink = base::RepeatingCallback<
      bool(content::WebContents*, const char*, base::DictValue)>;
  static void Start(ViewSink sink);
  // True suppresses Chrome's tab-strip activation. A parked Bay page retains
  // the request until its next mount; unrelated Chrome pages keep their UI.
  static bool RequestActivation(content::WebContents* contents);
  static void Replay(content::WebContents* contents);
  static bool HandleEngineEvent(std::string_view topic,
                                const base::DictValue& payload);
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_PAGE_LIFECYCLE_EVENTS_H_
