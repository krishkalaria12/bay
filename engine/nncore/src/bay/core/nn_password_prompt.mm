// The macOS host's side of the shared password prompts (nn_form_prompts.cc).

#include "bay/core/nn_password_prompt.h"

#include <optional>
#include <string>

#include "base/memory/weak_ptr.h"
#include "base/strings/sys_string_conversions.h"
#include "base/values.h"
#include "chrome/browser/ui/passwords/passwords_model_delegate.h"
#include "components/password_manager/core/common/password_manager_ui.h"
#include "bay/core/nn_form_prompts.h"
#include "bay/core/nn_mac_values.h"

namespace nncore {

NSDictionary<NSString*, id>* PasswordPrompt(content::WebContents* contents) {
  base::WeakPtr<PasswordsModelDelegate> model = forms::PasswordModel(contents);
  std::optional<base::DictValue> prompt =
      model ? forms::DescribePassword(*model) : std::nullopt;
  return prompt ? NSDictionaryFrom(*prompt) : nil;
}

void PasswordPromptShown(content::WebContents* contents) {
  // What Chrome's bubble reports once shown; resolving reports it hidden again.
  if (base::WeakPtr<PasswordsModelDelegate> model = forms::PasswordModel(contents)) {
    model->OnBubbleShown();
  }
}

void PasswordConfirmationShown(content::WebContents* contents) {
  // "Saved" asks nothing: the host may never answer it, so it counts as shown and closed
  // at once (Chrome's own closes by itself). A closed bubble lets a new page reset the state.
  base::WeakPtr<PasswordsModelDelegate> model = forms::PasswordModel(contents);
  if (model && forms::PasswordState(*model) == "saved") {
    model->OnBubbleHidden();
  }
}

void ResolvePasswordPrompt(content::WebContents* contents,
                           NSString* action,
                           NSString* username,
                           NSString* password) {
  forms::ResolvePassword(
      contents, base::SysNSStringToUTF8(action),
      username ? std::make_optional(base::SysNSStringToUTF8(username)) : std::nullopt,
      password ? std::make_optional(base::SysNSStringToUTF8(password)) : std::nullopt);
}

}  // namespace nncore
