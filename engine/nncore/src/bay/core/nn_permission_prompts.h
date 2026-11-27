// Copyright 2026 Bay. Apache-2.0.
// Chrome's permission prompts for a host's tabs go to the app (JS
// PermissionRequest): Chrome's PermissionRequestManager asks, the app answers
// once through the request's id. A site asking again for files it kept handles
// to is asked the same way, as a "fileSystem" request. Both desktop hosts keep
// their prompts here: macOS (nn_permissions.mm) and Windows and Linux
// (webui/permission_prompts.cc).
#ifndef BAY_CORE_NN_PERMISSION_PROMPTS_H_
#define BAY_CORE_NN_PERMISSION_PROMPTS_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}

namespace nncore::permission_prompts {

struct Host {
  Host();
  Host(Host&&);
  Host& operator=(Host&&);
  ~Host();

  // Whether the tab is the host's; Chrome's own windows keep Chrome's prompts.
  base::RepeatingCallback<bool(content::WebContents*)> holds;
  // Asks the app: {id, origin, permissions: [JS PermissionKind]}. Never from
  // inside Chrome's request manager (an answer re-enters it).
  base::RepeatingCallback<void(content::WebContents*, base::DictValue)> ask;
  // A request the app was asked about went; |answered| when the app answered
  // it itself. Not from inside the manager's cleanup: the app may close the
  // tab in response.
  base::RepeatingCallback<void(const std::string& id, bool answered)> gone;
};

// Installs Chrome's hooks. Later calls replace the host.
void Install(Host host);

// The app's answer: "accept", "deny" or "dismiss"; |remember| keeps it for the
// site. Taken once, applied from a task of its own; an answer to a request that
// has gone (or a second one) is dropped.
void Resolve(const std::string& request_id,
             const std::string& result,
             bool remember);

}  // namespace nncore::permission_prompts

#endif  // BAY_CORE_NN_PERMISSION_PROMPTS_H_
