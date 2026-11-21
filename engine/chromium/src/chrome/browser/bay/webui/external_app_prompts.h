// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_EXTERNAL_APP_PROMPTS_H_
#define CHROME_BROWSER_BAY_WEBUI_EXTERNAL_APP_PROMPTS_H_

#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}
namespace url {
class Origin;
}

namespace bay {

// Links to other apps (mailto:, zoommtg:…) from pages in Bay windows, as macOS
// nn_external_apps: Chrome decides as always (a blocked scheme, a remembered
// allow, a missing gesture), and where it would show its "Open <app>?" dialog
// the view asks with Bay's UI (onExternalApp). "Open" launches through Chrome.
class ExternalAppPrompts {
 public:
  // Sends |event| to the view showing the page; false when none does.
  using ViewSink = base::RepeatingCallback<
      bool(content::WebContents*, const char* event, base::DictValue payload)>;

  // Installs Chrome's dialog hook. Later calls replace the sink.
  static void Start(ViewSink sink);
  static void Resolve(const std::string& request_id, bool open, bool remember);

  // The JS ExternalAppRequest. |app|: the handler's name, or empty when the
  // desktop has none for the scheme.
  static base::DictValue Describe(const std::string& request_id,
                                  const std::string& url,
                                  const std::string& scheme,
                                  const std::optional<std::string>& origin,
                                  const std::string& app,
                                  const base::Value& icon,
                                  bool can_remember);
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_EXTERNAL_APP_PROMPTS_H_
