// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PERMISSION_PROMPTS_H_
#define CHROME_BROWSER_BAY_WEBUI_PERMISSION_PROMPTS_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"
#include "components/permissions/request_type.h"

namespace bay {

// Chrome's permission prompts for pages in Bay windows, asked with Bay's own UI
// instead of Chrome's bubble, as macOS nn_permissions. Chrome still decides
// first: a remembered allow or block never asks.
class PermissionPrompts {
 public:
  // BayCEF.onPermission {id, browserId, origin, permissions} and
  // onPermissionDismissed {id}.
  using Sink =
      base::RepeatingCallback<void(const char* event, base::DictValue payload)>;

  // Installs Chrome's prompt factory. Later calls replace the sink.
  static void Start(Sink sink);
  // "accept" | "deny" | "dismiss"; |remember| keeps the decision for the site
  // (a one-time grant where Chrome supports one; a forgotten "deny" is a
  // dismissal). An answer to a prompt that has gone is dropped.
  static void Resolve(const std::string& request_id,
                      const std::string& result,
                      bool remember);
  // The JS PermissionKind, or nullptr for one the app doesn't name.
  static const char* KindName(permissions::RequestType type);
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_PERMISSION_PROMPTS_H_
