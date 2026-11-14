// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/host_context.h"

#include <utility>

#include "base/check.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"

namespace bay {
HostContext::HostContext(Role role,
                         base::WeakPtr<Profile> profile,
                         base::WeakPtr<BrowserWindowInterface> window)
    : role_(role), profile_(std::move(profile)), window_(std::move(window)) {
  CHECK(profile_);
  CHECK_EQ(is_window(), !!window_);
}
HostContext HostContext::ForWindow(BrowserWindowInterface& window) {
  CHECK(window.GetProfile());
  return HostContext(Role::kWindow, window.GetProfile()->GetWeakPtr(),
                     window.GetWeakPtr());
}
HostContext HostContext::ForCoordinator(Profile& profile) {
  return HostContext(Role::kCoordinator, profile.GetWeakPtr(), {});
}
}  // namespace bay
