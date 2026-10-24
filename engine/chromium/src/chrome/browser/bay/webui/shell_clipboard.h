// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHELL_CLIPBOARD_H_
#define CHROME_BROWSER_BAY_WEBUI_SHELL_CLIPBOARD_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace bay {

// Synchronous UI-sequence operations. The caller owns profile/readiness and
// contract arity checks. The writer is destroyed before the response runs;
// there is no document-owned work to cancel on teardown.
class ShellClipboard {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;

  static base::ListValue SupportedMethods();
  // An unhandled method leaves callback untouched.
  static bool Dispatch(const std::string& module,
                       const std::string& method,
                       const base::ListValue& args,
                       Response& callback);
};

}  // namespace bay
#endif
