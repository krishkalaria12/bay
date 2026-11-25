// Copyright 2026 Bay. Apache-2.0.
// Chrome's save/update offers for passwords, addresses and cards in a host's
// tabs go to the app (JS PasswordPrompt, AutofillPrompt). Chrome owns the
// pending credentials and decisions; the app gets the display fields and
// answers the controller of the same tab. Both desktop hosts keep their prompts
// here: macOS (nn_autofill_prompt.mm, nn_password_prompt.mm) and Windows and
// Linux (webui/form_prompts.cc).
#ifndef BAY_CORE_NN_FORM_PROMPTS_H_
#define BAY_CORE_NN_FORM_PROMPTS_H_

#include <memory>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

class PasswordsModelDelegate;
namespace autofill {
class AutofillBubbleBase;
class SaveAddressBubbleController;
class SaveCardBubbleController;
class UpdateAddressBubbleController;
}  // namespace autofill
namespace content {
class WebContents;
}

namespace nncore::forms {

// The tab's Chrome password controller, or null.
base::WeakPtr<PasswordsModelDelegate> PasswordModel(
    content::WebContents* contents);

// The JS PasswordPrompt state: "save", "update", "saved", or empty when the
// controller asks nothing.
std::string PasswordState(const PasswordsModelDelegate& model);

// The JS PasswordPrompt, or nothing when the controller asks nothing.
std::optional<base::DictValue> DescribePassword(
    const PasswordsModelDelegate& model);

// Only what the current prompt offers: a late or repeated answer (a second
// "save" after the first moved Chrome on) would hit the controller's state
// CHECKs.
bool IsPasswordActionAllowed(const std::string& state,
                             const std::string& action);

// Answers the tab's password prompt, as Chrome's bubble closing after it. An
// answer the prompt doesn't offer is dropped whole: it never closes a newer
// prompt either. An empty |username| or |password| keeps the pending one.
bool ResolvePassword(content::WebContents* contents,
                     const std::string& action,
                     const std::optional<std::string>& username,
                     const std::optional<std::string>& password);

// Tells the app of an autofill prompt (its payload) or of one closing
// ({id, closed: true}).
using Tell =
    base::RepeatingCallback<void(content::WebContents*, base::DictValue)>;
void SetAutofillTell(Tell tell);

// Chrome showing a bubble: the tab's prompt now, told to the app once the
// controller holds it (an app answering at once must not close it before
// Chrome has it). Address controllers belong to the prompt, as to Chrome's
// view; the card controller belongs to the tab. Only a local card save (or
// its CVC) has a prompt.
autofill::AutofillBubbleBase* ShowSaveAddress(
    content::WebContents* contents,
    std::unique_ptr<autofill::SaveAddressBubbleController> controller);
autofill::AutofillBubbleBase* ShowUpdateAddress(
    content::WebContents* contents,
    std::unique_ptr<autofill::UpdateAddressBubbleController> controller);
autofill::AutofillBubbleBase* ShowSaveCard(
    content::WebContents* contents,
    autofill::SaveCardBubbleController* controller);

// The tab's pending autofill prompt (JS AutofillPrompt).
std::optional<base::DictValue> AutofillPrompt(content::WebContents* contents);

// "accept", "decline" or "dismiss" for the tab's pending prompt |id|; false
// for anything else.
bool ResolveAutofill(content::WebContents* contents,
                     int id,
                     const std::string& action);

}  // namespace nncore::forms

#endif  // BAY_CORE_NN_FORM_PROMPTS_H_
