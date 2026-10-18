// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_HOST_CONTEXT_H_
#define CHROME_BROWSER_BAY_WEBUI_HOST_CONTEXT_H_

#include "base/memory/weak_ptr.h"

class BrowserWindowInterface;
class Profile;

namespace bay {
// UI-sequence browser-assigned authority and lifetime references. A role never
// comes from renderer arguments or a URL. The owner must keep its profile
// alive; expired references cause requests to fail rather than borrowing
// another context.
class HostContext {
 public:
  enum class Role { kWindow, kCoordinator };
  static HostContext ForWindow(BrowserWindowInterface& window);
  static HostContext ForCoordinator(Profile& profile);

  Role role() const { return role_; }
  bool is_window() const { return role_ == Role::kWindow; }
  const char* role_name() const {
    return is_window() ? "window" : "coordinator";
  }
  Profile* profile() const { return profile_.get(); }
  BrowserWindowInterface* window() const { return window_.get(); }

 private:
  HostContext(Role role,
              base::WeakPtr<Profile> profile,
              base::WeakPtr<BrowserWindowInterface> window);
  const Role role_;
  const base::WeakPtr<Profile> profile_;
  const base::WeakPtr<BrowserWindowInterface> window_;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_HOST_CONTEXT_H_
