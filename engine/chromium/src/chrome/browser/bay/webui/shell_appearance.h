// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHELL_APPEARANCE_H_
#define CHROME_BROWSER_BAY_WEBUI_SHELL_APPEARANCE_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/host_context.h"

namespace bay {
// UI-sequence operations. The caller owns readiness, profile and contract arity
// checks, including Windows' initialization-error gate.
class ShellAppearance {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  static base::ListValue SupportedMethods();
  // An unhandled method leaves callback untouched.
  static bool Dispatch(const HostContext& context,
                       const std::string& module,
                       const std::string& method,
                       const base::ListValue& args,
                       Response& callback);
};
}  // namespace bay
#endif
