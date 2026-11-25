// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/permission_prompts.h"

#include <utility>

#include "bay/core/nn_permission_flow.h"
#include "bay/core/nn_permission_prompts.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/web_contents.h"

namespace bay {
namespace {

PermissionPrompts::Sink& EventSink() {
  static base::NoDestructor<PermissionPrompts::Sink> sink;
  return *sink;
}

void Tell(const char* event, base::DictValue payload) {
  if (EventSink())
    EventSink().Run(event, std::move(payload));
}

}  // namespace

// static
const char* PermissionPrompts::KindName(permissions::RequestType type) {
  return nncore::PermissionKindName(type);
}

// static
void PermissionPrompts::Start(Sink sink) {
  EventSink() = std::move(sink);
  nncore::permission_prompts::Host host;
  // A window Chrome made itself keeps Chrome's prompt.
  host.holds = base::BindRepeating([](content::WebContents* contents) {
    return WindowRegistry::Get().HoldsTab(contents);
  });
  host.ask = base::BindRepeating(
      [](content::WebContents* contents, base::DictValue request) {
        request.Set("browserId",
                    sessions::SessionTabHelper::IdForTab(contents).id());
        Tell("onPermission", std::move(request));
      });
  // Answered too: every window was told, and only one answered.
  host.gone = base::BindRepeating([](const std::string& id, bool) {
    Tell("onPermissionDismissed", base::DictValue().Set("id", id));
  });
  nncore::permission_prompts::Install(std::move(host));
}

// static
void PermissionPrompts::Resolve(const std::string& request_id,
                                const std::string& result,
                                bool remember) {
  nncore::permission_prompts::Resolve(request_id, result, remember);
}

}  // namespace bay
