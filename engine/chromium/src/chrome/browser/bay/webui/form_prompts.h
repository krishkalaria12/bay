// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_FORM_PROMPTS_H_
#define CHROME_BROWSER_BAY_WEBUI_FORM_PROMPTS_H_

#include <optional>
#include <string>
#include "base/functional/callback.h"
#include "base/values.h"

class PasswordsModelDelegate;
namespace content {
class WebContents;
}
namespace bay {
// Chrome owns pending credentials and autofill decisions. The host only gets
// the display fields, and answers the controller for this same WebContents.
class FormPrompts {
 public:
  using Sink = base::RepeatingCallback<
      void(content::WebContents*, const char*, base::DictValue)>;
  using TabGate = base::RepeatingCallback<bool(content::WebContents*)>;
  // The default gate accepts only pages held by a Bay window. An explicit
  // gate lets native tests exercise the real controller adapters.
  static void Start(Sink sink, TabGate gate = {});
  static std::optional<base::DictValue> Password(
      content::WebContents* contents);
  static std::optional<base::DictValue> Password(
      const PasswordsModelDelegate& model);
  static std::optional<base::DictValue> Autofill(
      content::WebContents* contents);
  static bool ResolvePassword(content::WebContents* contents,
                              const std::string& action,
                              const std::optional<std::string>& username,
                              const std::optional<std::string>& password);
  static bool ResolveAutofill(content::WebContents* contents,
                              int id,
                              const std::string& action);
  static bool IsPasswordActionAllowed(const std::string& state,
                                      const std::string& action);
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_FORM_PROMPTS_H_
