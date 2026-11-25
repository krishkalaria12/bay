// Copyright 2026 Bay. Apache-2.0.
// What a Chrome permission prompt asks, as both desktop hosts show it: macOS
// (nn_permissions.mm) and Windows and Linux (webui/permission_prompts.cc).
#ifndef BAY_CORE_NN_PERMISSION_FLOW_H_
#define BAY_CORE_NN_PERMISSION_FLOW_H_

#include "components/permissions/permission_prompt.h"
#include "components/permissions/request_type.h"

namespace nncore {

// A page's permission element runs Chrome's embedded flow: after the site is
// allowed, the manager keeps the same requests and shows the next step (ask the
// system, open its settings, an administrator's policy), the views Chrome's
// EmbeddedPermissionPrompt picks by variant. Only the flow's first view can be a
// question: a later one holds requests already decided, and deciding one twice
// runs its spent callback. A later view is never a question even if its variant
// says so (the site's setting reset while the system was being asked): it
// closes, as Chrome's acknowledgement does.
enum class PermissionStep { kAsk, kAlreadyAllowed, kSystemPrompt, kAcknowledge };

PermissionStep PermissionStepOf(
    permissions::PermissionPrompt::Delegate* delegate);

// The app's name for a request (JS PermissionKind); nullptr for one it doesn't
// show.
const char* PermissionKindName(permissions::RequestType type);

}  // namespace nncore

#endif  // BAY_CORE_NN_PERMISSION_FLOW_H_
