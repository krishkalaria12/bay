// Copyright 2026 Bay. Apache-2.0.
// Links to other apps (mailto:, zoommtg:…) from a host's tabs: Chrome decides as
// always (a blocked scheme, a remembered allow, a missing gesture), and where it
// would show its "Open <app>?" dialog the app asks instead (JS
// ExternalAppRequest). "Open" launches through Chrome. Both desktop hosts keep
// their requests here: macOS (nn_external_apps.mm) and Windows and Linux
// (webui/external_app_prompts.cc); each finds the scheme's handler its own way.
#ifndef BAY_CORE_NN_EXTERNAL_APP_REQUESTS_H_
#define BAY_CORE_NN_EXTERNAL_APP_REQUESTS_H_

#include <optional>
#include <string>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/weak_document_ptr.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace content {
class WebContents;
}

namespace nncore::external_apps {

std::string NextRequestId();

// As Chrome's dialog: "always" only for a trustworthy origin, outside private
// windows.
bool CanRemember(content::WebContents* contents,
                 const std::optional<url::Origin>& origin,
                 bool has_app);

// The JS ExternalAppRequest. |app|: the handler's name, or empty when the
// desktop has none for the scheme; |computer| names the desktop in that case
// ("Your Mac").
base::DictValue Describe(const std::string& request_id,
                         const std::string& url,
                         const std::string& scheme,
                         const std::optional<std::string>& origin,
                         const std::string& app,
                         const std::optional<std::string>& app_path,
                         const base::Value& icon,
                         bool can_remember,
                         const std::string& computer);

// A request with a handler waits for the app's answer.
void Keep(const std::string& request_id,
          GURL url,
          content::WebContents* contents,
          std::optional<url::Origin> origin,
          content::WeakDocumentPtr initiator,
          bool can_remember);

// What "Open" launches.
struct Approval {
  GURL url;
  base::WeakPtr<content::WebContents> contents;
  std::optional<url::Origin> origin;
  content::WeakDocumentPtr initiator;
};

// The app's answer. A request that opens, from a page still there, comes back
// to launch, after Chrome's own "always allow" (its protocol_handler prefs) is
// remembered as its dialog's checkbox would.
std::optional<Approval> Resolve(const std::string& request_id,
                                bool open,
                                bool remember);
void Launch(const Approval& approval);

}  // namespace nncore::external_apps

#endif  // BAY_CORE_NN_EXTERNAL_APP_REQUESTS_H_
