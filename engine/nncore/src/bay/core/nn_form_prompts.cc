// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_form_prompts.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_split.h"
#include "base/strings/utf_string_conversions.h"
#include "base/supports_user_data.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/ui/autofill/autofill_bubble_base.h"
#include "chrome/browser/ui/autofill/payments/save_card_bubble_controller.h"
#include "chrome/browser/ui/autofill/payments/save_card_ui.h"
#include "chrome/browser/ui/autofill/save_address_bubble_controller.h"
#include "chrome/browser/ui/autofill/update_address_bubble_controller.h"
#include "chrome/browser/ui/passwords/manage_passwords_ui_controller.h"
#include "chrome/browser/ui/passwords/passwords_model_delegate.h"
#include "components/autofill/core/browser/data_model/addresses/autofill_profile.h"
#include "components/autofill/core/browser/data_model/addresses/autofill_profile_comparator.h"
#include "components/autofill/core/browser/data_model/payments/credit_card.h"
#include "components/autofill/core/browser/foundations/autofill_client.h"
#include "components/autofill/core/browser/ui/addresses/autofill_address_util.h"
#include "components/autofill/core/browser/ui/payments/payments_ui_closed_reasons.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_string.h"
#include "components/password_manager/core/common/password_manager_ui.h"
#include "components/strings/grit/components_strings.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/l10n/l10n_util.h"
#include "url/origin.h"

namespace nncore::forms {
namespace {

std::string UTF8(const std::u16string& value) {
  return base::UTF16ToUTF8(value);
}

// Each line of a multi-line summary (Chrome's address summary is one string
// with newlines).
base::ListValue Lines(const std::u16string& text) {
  base::ListValue result;
  for (const auto& line : base::SplitString(
           text, u"\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    result.Append(UTF8(line));
  }
  return result;
}

Tell& Teller() {
  static base::NoDestructor<Tell> tell;
  return *tell;
}

using Decision = autofill::AutofillClient::AddressPromptUserDecision;

class Prompt;

// The tab's pending prompt (the one the app was told about last).
struct PromptSlot : public base::SupportsUserData::Data {
  base::WeakPtr<Prompt> prompt;
};
constexpr char kSlot[] = "nncore_autofill_prompt";

Prompt* Pending(content::WebContents* contents);

class Prompt : public autofill::AutofillBubbleBase,
               public content::WebContentsObserver {
 public:
  explicit Prompt(content::WebContents* contents)
      : WebContentsObserver(contents), page_(contents->GetWeakPtr()) {
    static int last_id = 0;
    id_ = ++last_id;
  }
  Prompt(const Prompt&) = delete;
  Prompt& operator=(const Prompt&) = delete;
  ~Prompt() override = default;

  int id() const { return id_; }
  bool closed() const { return closed_; }
  base::WeakPtr<Prompt> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

  // What the app shows (the kind, Chrome's strings, what is saved), without
  // the id and origin.
  virtual base::DictValue Describe() const = 0;

  base::DictValue Payload() const {
    auto result = Describe();
    result.Set("id", id_);
    result.Set(
        "origin",
        page_
            ? page_->GetPrimaryMainFrame()->GetLastCommittedOrigin().Serialize()
            : "");
    return result;
  }

  Prompt* Show() {
    if (!page_) {
      return this;
    }
    if (Prompt* previous = Pending(page_.get())) {
      previous->Hide();
    }
    if (!page_) {
      return this;
    }
    auto slot = std::make_unique<PromptSlot>();
    slot->prompt = GetWeakPtr();
    page_->SetUserData(kSlot, std::move(slot));
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<Prompt> prompt) {
                         if (prompt && !prompt->closed_) {
                           prompt->Notify(prompt->Payload());
                         }
                       },
                       GetWeakPtr()));
    return this;
  }

  // The app's answer. Chrome's bubble runs the decision, then closes (which
  // tells the controller it went); the decision may already have hidden it
  // (Chrome then shows another).
  bool Answer(const std::string& action) {
    if (closed_ ||
        (action != "accept" && action != "decline" && action != "dismiss")) {
      return false;
    }
    // Marked before the decision re-enters Chrome: a save may hide its bubble
    // at once, and that close keeps the user's reason.
    action_ = action;
    if (action == "accept") {
      Accept();
    } else if (action == "decline") {
      Decline();
    }
    Close();
    return true;
  }

  // autofill::AutofillBubbleBase: Chrome hides it (the tab was switched away
  // from, the page went, another offer replaces it, the controller is going).
  void Hide() override { Close(); }
  bool IsMouseHovered() const override { return false; }

 protected:
  virtual void Accept() = 0;
  virtual void Decline() = 0;
  // Tells the controller its bubble went, as Chrome's view does when its widget
  // closes; after this the prompt never calls the controller again. |action|
  // is the app's answer, empty when Chrome closed it.
  virtual void Closed(const std::string& action) = 0;

 private:
  void Close() {
    if (closed_) {
      return;
    }
    closed_ = true;
    if (page_) {
      auto* slot = static_cast<PromptSlot*>(page_->GetUserData(kSlot));
      if (slot && slot->prompt.get() == this) {
        page_->RemoveUserData(kSlot);
      }
    }
    // The app hears of this one closing before the controller can show the
    // next.
    Notify(base::DictValue().Set("id", id_).Set("closed", true));
    Closed(action_);
    // Chrome's bubble goes asynchronously too: a controller may still be on
    // the stack.
    base::SingleThreadTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE,
                                                                  this);
  }

  void Notify(base::DictValue payload) const {
    if (page_ && Teller()) {
      Teller().Run(page_.get(), std::move(payload));
    }
  }

  void WebContentsDestroyed() override {
    // Nothing goes to a tab being torn down.
    page_.reset();
    Close();
  }

  base::WeakPtr<content::WebContents> page_;
  int id_ = 0;
  bool closed_ = false;
  std::string action_;
  base::WeakPtrFactory<Prompt> weak_factory_{this};
};

Prompt* Pending(content::WebContents* contents) {
  auto* slot = contents ? static_cast<PromptSlot*>(contents->GetUserData(kSlot))
                        : nullptr;
  Prompt* prompt = slot ? slot->prompt.get() : nullptr;
  return prompt && !prompt->closed() ? prompt : nullptr;
}

// "Save address?" (save_address_profile_view.cc).
class SaveAddress : public Prompt {
 public:
  SaveAddress(content::WebContents* page,
              std::unique_ptr<autofill::SaveAddressBubbleController> controller)
      : Prompt(page), controller_(std::move(controller)) {}

  base::DictValue Describe() const override {
    auto lines = Lines(controller_->GetAddressSummary());
    for (const auto& extra :
         {controller_->GetProfileEmail(), controller_->GetProfilePhone()}) {
      if (!extra.empty()) {
        lines.Append(UTF8(extra));
      }
    }
    return base::DictValue()
        .Set("kind", "saveAddress")
        .Set("title", UTF8(controller_->GetWindowTitle()))
        .Set("message", UTF8(controller_->GetBodyText()))
        .Set("accept", UTF8(controller_->GetOkButtonLabel()))
        .Set("decline", UTF8(controller_->GetNegativeButtonLabel()))
        .Set("footer", UTF8(controller_->GetFooterMessage()))
        .Set("lines", std::move(lines));
  }

 protected:
  void Accept() override {
    controller_->OnUserDecision(Decision::kAccepted,
                                controller_->GetAutofillProfile());
  }
  void Decline() override {
    controller_->OnUserDecision(controller_->GetCancelCallbackValue(),
                                std::nullopt);
  }
  void Closed(const std::string&) override { controller_->OnBubbleClosed(); }

 private:
  std::unique_ptr<autofill::SaveAddressBubbleController> controller_;
};

// "Update address?" / "Add to address?" (update_address_profile_view.cc).
class UpdateAddress : public Prompt {
 public:
  UpdateAddress(
      content::WebContents* page,
      std::unique_ptr<autofill::UpdateAddressBubbleController> controller)
      : Prompt(page), controller_(std::move(controller)) {}

  base::DictValue Describe() const override {
    const std::string& locale = g_browser_process->GetApplicationLocale();
    const auto diff = autofill::GetProfileDifferenceForUi(
        controller_->GetProfileToSave(), controller_->GetOriginalProfile(),
        locale);
    bool adds_only = true;
    bool address = false;
    base::ListValue changes;
    for (const auto& entry : diff) {
      adds_only &= entry.second_value.empty();
      address |= entry.type == autofill::ADDRESS_HOME_ADDRESS;
      const char* field = "other";
      switch (autofill::GetAddressUIComponentIconTypeForFieldType(entry.type)) {
        case autofill::AddressUIComponentIconType::kName:
          field = "name";
          break;
        case autofill::AddressUIComponentIconType::kAddress:
          field = "address";
          break;
        case autofill::AddressUIComponentIconType::kEmail:
          field = "email";
          break;
        case autofill::AddressUIComponentIconType::kPhone:
          field = "phone";
          break;
        case autofill::AddressUIComponentIconType::kNoIcon:
          break;
      }
      changes.Append(base::DictValue()
                         .Set("field", field)
                         .Set("to", UTF8(entry.first_value))
                         .Set("from", UTF8(entry.second_value)));
    }
    const auto label = [adds_only](int id) {
      return adds_only ? std::string() : UTF8(l10n_util::GetStringUTF16(id));
    };
    return base::DictValue()
        .Set("kind", "updateAddress")
        .Set("title", UTF8(controller_->GetWindowTitle(adds_only)))
        .Set("message", UTF8(autofill::GetProfileDescription(
                            controller_->GetOriginalProfile(), locale,
                            /*include_address_and_contacts=*/!address)))
        .Set("accept", UTF8(controller_->GetPositiveButtonText(adds_only)))
        .Set("decline", UTF8(controller_->GetNegativeButtonText(adds_only)))
        .Set("footer", UTF8(controller_->GetFooterMessage()))
        .Set("lines", base::ListValue())
        .Set("changes", std::move(changes))
        .Set("newLabel",
             label(IDS_AUTOFILL_UPDATE_ADDRESS_PROMPT_NEW_VALUES_SECTION_LABEL))
        .Set("oldLabel",
             label(IDS_AUTOFILL_UPDATE_ADDRESS_PROMPT_OLD_VALUES_SECTION_LABEL));
  }

 protected:
  void Accept() override {
    controller_->OnUserDecision(Decision::kAccepted,
                                controller_->GetProfileToSave());
  }
  void Decline() override {
    controller_->OnUserDecision(Decision::kDeclined, std::nullopt);
  }
  void Closed(const std::string&) override { controller_->OnBubbleClosed(); }

 private:
  std::unique_ptr<autofill::UpdateAddressBubbleController> controller_;
};

// "Save card?" on this computer (save_card_bubble_views.cc,
// save_card_offer_bubble_views.cc). The controller belongs to the tab; it hides
// the prompt before it goes, and hears of the close through its weak callback,
// as Chrome's view does.
class SaveCard : public Prompt {
 public:
  SaveCard(content::WebContents* page,
           autofill::SaveCardBubbleController* controller)
      : Prompt(page),
        controller_(controller),
        on_closed_(controller->GetOnBubbleClosedCallback()) {}

  base::DictValue Describe() const override {
    const autofill::CreditCard& card = controller_->GetCard();
    std::u16string summary = card.CardNameAndLastFourDigits(
        /*customized_nickname=*/u"", /*obfuscation_length=*/2);
    if (!card.IsExpired(base::Time::Now())) {
      summary += u" • " + card.AbbreviatedExpirationDateForDisplay(false);
    }
    return base::DictValue()
        .Set("kind", "saveCard")
        .Set("title", UTF8(controller_->GetWindowTitle()))
        .Set("message", UTF8(controller_->GetExplanatoryMessage()))
        .Set("accept", UTF8(controller_->GetAcceptButtonText()))
        .Set("decline", UTF8(controller_->GetDeclineButtonText()))
        .Set("footer", "")
        .Set("lines", base::ListValue().Append(UTF8(summary)));
  }

 protected:
  void Accept() override { controller_->OnSaveButton({}); }
  void Decline() override {}
  void Closed(const std::string& action) override {
    // The reason Chrome's widget gives (GetPaymentsUiClosedReasonFromWidget):
    // Chrome hiding it closes the widget for no reason of the user's.
    using Reason = autofill::PaymentsUiClosedReason;
    const Reason reason = action == "accept"    ? Reason::kAccepted
                          : action == "decline" ? Reason::kCancelled
                          : action == "dismiss" ? Reason::kClosed
                                                : Reason::kNotInteracted;
    if (on_closed_) {
      std::move(on_closed_).Run(reason);
    }
  }

 private:
  raw_ptr<autofill::SaveCardBubbleController> controller_;
  base::OnceCallback<void(autofill::PaymentsUiClosedReason)> on_closed_;
};

}  // namespace

base::WeakPtr<PasswordsModelDelegate> PasswordModel(
    content::WebContents* contents) {
  return contents && ManagePasswordsUIController::FromWebContents(contents)
             ? PasswordsModelDelegateFromWebContents(contents)
             : nullptr;
}

std::string PasswordState(const PasswordsModelDelegate& model) {
  using password_manager::ui::State;
  switch (model.GetState()) {
    case State::PENDING_PASSWORD_STATE:
      return "save";
    case State::PENDING_PASSWORD_UPDATE_STATE:
      return "update";
    case State::SAVE_CONFIRMATION_STATE:
    case State::UPDATE_CONFIRMATION_STATE:
      return "saved";
    default:
      return {};
  }
}

std::optional<base::DictValue> DescribePassword(
    const PasswordsModelDelegate& model) {
  const std::string state = PasswordState(model);
  if (state.empty()) {
    return std::nullopt;
  }
  // The pending form's details, for the states that have one.
  std::string username;
  std::string federation;
  int length = 0;
  if (model.GetState() !=
      password_manager::ui::State::UPDATE_CONFIRMATION_STATE) {
    const password_manager::PasswordForm& form = model.GetPendingPassword();
    username = UTF8(form.username_value);
    length = static_cast<int>(form.password_value.size());
    if (form.federation_origin.IsValid()) {
      federation = form.federation_origin.Serialize();
    }
  }
  base::ListValue usernames;
  for (const auto& form : model.GetCurrentForms()) {
    if (form && !form->username_value.empty()) {
      usernames.Append(UTF8(form->username_value));
    }
  }
  return base::DictValue()
      .Set("state", state)
      .Set("origin", model.GetOrigin().Serialize())
      .Set("username", username)
      .Set("passwordLength", length)
      .Set("federation", federation)
      .Set("usernames", std::move(usernames));
}

bool IsPasswordActionAllowed(const std::string& state,
                             const std::string& action) {
  return ((action == "save" || action == "update") &&
          (state == "save" || state == "update")) ||
         (action == "never" && state == "save") ||
         (action == "nope" && state == "update") ||
         (action == "dismiss" && !state.empty());
}

bool ResolvePassword(content::WebContents* contents,
                     const std::string& action,
                     const std::optional<std::string>& username,
                     const std::optional<std::string>& password) {
  base::WeakPtr<PasswordsModelDelegate> model = PasswordModel(contents);
  if (!model || !IsPasswordActionAllowed(PasswordState(*model), action)) {
    return false;
  }
  if (action == "save" || action == "update") {
    const password_manager::PasswordForm& pending = model->GetPendingPassword();
    model->SavePassword(
        username && !username->empty() ? base::UTF8ToUTF16(*username)
                                       : pending.username_value,
        password && !password->empty()
            ? password_manager::PasswordString(base::UTF8ToUTF16(*password))
            : pending.password_value);
  } else if (action == "never") {
    model->NeverSavePassword();
  } else if (action == "nope") {
    model->OnNopeUpdateClicked();
  }
  // As Chrome's bubble closing after any of these (the action may have
  // destroyed the model).
  if (model) {
    model->OnBubbleHidden();
  }
  return true;
}

void SetAutofillTell(Tell tell) {
  Teller() = std::move(tell);
}

autofill::AutofillBubbleBase* ShowSaveAddress(
    content::WebContents* contents,
    std::unique_ptr<autofill::SaveAddressBubbleController> controller) {
  return (new SaveAddress(contents, std::move(controller)))->Show();
}

autofill::AutofillBubbleBase* ShowUpdateAddress(
    content::WebContents* contents,
    std::unique_ptr<autofill::UpdateAddressBubbleController> controller) {
  return (new UpdateAddress(contents, std::move(controller)))->Show();
}

autofill::AutofillBubbleBase* ShowSaveCard(
    content::WebContents* contents,
    autofill::SaveCardBubbleController* controller) {
  return (new SaveCard(contents, controller))->Show();
}

std::optional<base::DictValue> AutofillPrompt(content::WebContents* contents) {
  const Prompt* prompt = Pending(contents);
  return prompt ? std::make_optional(prompt->Payload()) : std::nullopt;
}

bool ResolveAutofill(content::WebContents* contents,
                     int id,
                     const std::string& action) {
  Prompt* prompt = Pending(contents);
  return prompt && prompt->id() == id && prompt->Answer(action);
}

}  // namespace nncore::forms
