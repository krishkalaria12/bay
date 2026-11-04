// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/form_prompts.h"

#include <memory>
#include <utility>
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_split.h"
#include "base/strings/utf_string_conversions.h"
#include "base/supports_user_data.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/bay/webui/window_registry.h"
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
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/l10n/l10n_util.h"
#include "url/origin.h"

// Defined by chromium-form-prompts-webui.patch in Chrome's UI controllers.
extern bool (*g_bay_webui_password_bubble)(content::WebContents*);
namespace autofill {
extern AutofillBubbleBase* (*g_bay_webui_save_address_bubble)(
    content::WebContents*,
    std::unique_ptr<SaveAddressBubbleController>&);
extern AutofillBubbleBase* (*g_bay_webui_update_address_bubble)(
    content::WebContents*,
    std::unique_ptr<UpdateAddressBubbleController>&);
extern AutofillBubbleBase* (*g_bay_webui_save_card_bubble)(
    content::WebContents*,
    SaveCardBubbleController*);
}  // namespace autofill

namespace bay {
namespace {
FormPrompts::Sink& EventSink() {
  static base::NoDestructor<FormPrompts::Sink> sink;
  return *sink;
}
FormPrompts::TabGate& Gate() {
  static base::NoDestructor<FormPrompts::TabGate> gate;
  return *gate;
}
bool CanHandle(content::WebContents* contents) {
  return EventSink() && contents &&
         (Gate() ? Gate().Run(contents)
                 : WindowRegistry::Get().HoldsTab(contents));
}
void Tell(content::WebContents* contents,
          const char* event,
          base::DictValue payload) {
  if (CanHandle(contents))
    EventSink().Run(contents, event, std::move(payload));
}
base::ListValue Lines(const std::u16string& text) {
  base::ListValue result;
  for (auto& line : base::SplitString(text, u"\n", base::TRIM_WHITESPACE,
                                      base::SPLIT_WANT_NONEMPTY))
    result.Append(base::UTF16ToUTF8(line));
  return result;
}
std::string UTF8(const std::u16string& value) {
  return base::UTF16ToUTF8(value);
}
std::string PasswordState(const PasswordsModelDelegate* model) {
  using password_manager::ui::State;
  switch (model->GetState()) {
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
base::WeakPtr<PasswordsModelDelegate> ModelFor(content::WebContents* contents) {
  return contents && ManagePasswordsUIController::FromWebContents(contents)
             ? PasswordsModelDelegateFromWebContents(contents)
             : nullptr;
}
bool PasswordBubble(content::WebContents* contents) {
  auto payload = FormPrompts::Password(contents);
  if (!CanHandle(contents) || !payload)
    return false;
  const bool confirmation = *payload->FindString("state") == "saved";
  auto model = ModelFor(contents);
  if (!model)
    return false;
  model->OnBubbleShown();
  // Chrome's controller must finish opening before the host may answer it.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<content::WebContents> page,
             base::WeakPtr<PasswordsModelDelegate> model,
             base::DictValue payload, bool confirmation) {
            if (!page || !model)
              return;
            const auto current = FormPrompts::Password(page.get());
            // Do not deliver an obsolete offer after a navigation or another
            // submission has changed what the controller is asking about.
            if (!current || *current != payload)
              return;
            Tell(page.get(), "onPasswordPrompt", std::move(payload));
            if (confirmation && model && PasswordState(model.get()) == "saved")
              model->OnBubbleHidden();
          },
          contents->GetWeakPtr(), model, std::move(*payload), confirmation));
  return true;
}

using Decision = autofill::AutofillClient::AddressPromptUserDecision;
class Prompt;
struct PromptSlot : public base::SupportsUserData::Data {
  base::WeakPtr<Prompt> prompt;
};
constexpr char kSlot[] = "bay_webui_autofill_prompt";
Prompt* Pending(content::WebContents* contents);

// Address controllers are owned by the view, card controllers by Chrome's tab.
// Hide/close always settles the controller before asynchronous view deletion.
class Prompt : public autofill::AutofillBubbleBase,
               public content::WebContentsObserver {
 public:
  explicit Prompt(content::WebContents* contents)
      : WebContentsObserver(contents), page_(contents->GetWeakPtr()) {
    static int next_id = 0;
    id_ = ++next_id;
  }
  ~Prompt() override = default;
  int id() const { return id_; }
  bool closed() const { return closed_; }
  base::WeakPtr<Prompt> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }
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
    if (!page_)
      return this;
    if (auto* previous = Pending(page_.get()))
      previous->Hide();
    if (!page_)
      return this;
    auto slot = std::make_unique<PromptSlot>();
    slot->prompt = GetWeakPtr();
    page_->SetUserData(kSlot, std::move(slot));
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<Prompt> prompt) {
                         if (prompt && !prompt->closed_)
                           prompt->Notify(prompt->Payload());
                       },
                       GetWeakPtr()));
    return this;
  }
  bool Answer(const std::string& action) {
    if (closed_ ||
        (action != "accept" && action != "decline" && action != "dismiss"))
      return false;
    // Mark the decision before it re-enters Chrome. A save may synchronously
    // hide its bubble; that path must preserve the user's close reason.
    action_ = action;
    if (action == "accept")
      Accept();
    else if (action == "decline")
      Decline();
    Close();
    return true;
  }
  void Hide() override { Close(); }
  bool IsMouseHovered() const override { return false; }

 protected:
  virtual void Accept() = 0;
  virtual void Decline() = 0;
  virtual void Closed(const std::string& action) = 0;

 private:
  void Close() {
    if (closed_)
      return;
    closed_ = true;
    if (page_) {
      auto* slot = static_cast<PromptSlot*>(page_->GetUserData(kSlot));
      if (slot && slot->prompt.get() == this)
        page_->RemoveUserData(kSlot);
    }
    Notify(base::DictValue().Set("id", id_).Set("closed", true));
    Closed(action_);
    base::SingleThreadTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE,
                                                                  this);
  }
  void Notify(base::DictValue payload) const {
    if (page_)
      Tell(page_.get(), "onAutofillPrompt", std::move(payload));
  }
  void WebContentsDestroyed() override {
    // Do not send an event into a document while its tab is being torn down.
    page_.reset();
    Close();
  }
  base::WeakPtr<content::WebContents> page_;
  int id_;
  bool closed_ = false;
  std::string action_;
  base::WeakPtrFactory<Prompt> weak_factory_{this};
};
Prompt* Pending(content::WebContents* contents) {
  auto* slot = contents ? static_cast<PromptSlot*>(contents->GetUserData(kSlot))
                        : nullptr;
  auto* prompt = slot ? slot->prompt.get() : nullptr;
  return prompt && !prompt->closed() ? prompt : nullptr;
}
class SaveAddress : public Prompt {
 public:
  SaveAddress(content::WebContents* page,
              std::unique_ptr<autofill::SaveAddressBubbleController> controller)
      : Prompt(page), controller_(std::move(controller)) {}
  base::DictValue Describe() const override {
    auto lines = Lines(controller_->GetAddressSummary());
    for (const auto& extra :
         {controller_->GetProfileEmail(), controller_->GetProfilePhone()})
      if (!extra.empty())
        lines.Append(UTF8(extra));
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
class UpdateAddress : public Prompt {
 public:
  UpdateAddress(
      content::WebContents* page,
      std::unique_ptr<autofill::UpdateAddressBubbleController> controller)
      : Prompt(page), controller_(std::move(controller)) {}
  base::DictValue Describe() const override {
    const auto& locale = g_browser_process->GetApplicationLocale();
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
    return base::DictValue()
        .Set("kind", "updateAddress")
        .Set("title", UTF8(controller_->GetWindowTitle(adds_only)))
        .Set("message",
             UTF8(autofill::GetProfileDescription(
                 controller_->GetOriginalProfile(), locale, !address)))
        .Set("accept", UTF8(controller_->GetPositiveButtonText(adds_only)))
        .Set("decline", UTF8(controller_->GetNegativeButtonText(adds_only)))
        .Set("footer", UTF8(controller_->GetFooterMessage()))
        .Set("lines", base::ListValue())
        .Set("changes", std::move(changes))
        .Set(
            "newLabel",
            adds_only
                ? ""
                : UTF8(l10n_util::GetStringUTF16(
                      IDS_AUTOFILL_UPDATE_ADDRESS_PROMPT_NEW_VALUES_SECTION_LABEL)))
        .Set(
            "oldLabel",
            adds_only
                ? ""
                : UTF8(l10n_util::GetStringUTF16(
                      IDS_AUTOFILL_UPDATE_ADDRESS_PROMPT_OLD_VALUES_SECTION_LABEL)));
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
class SaveCard : public Prompt {
 public:
  SaveCard(content::WebContents* page,
           autofill::SaveCardBubbleController* controller)
      : Prompt(page),
        controller_(controller),
        on_closed_(controller->GetOnBubbleClosedCallback()) {}
  base::DictValue Describe() const override {
    const auto& card = controller_->GetCard();
    auto summary = card.CardNameAndLastFourDigits(u"", 2);
    if (!card.IsExpired(base::Time::Now()))
      summary += u" • " + card.AbbreviatedExpirationDateForDisplay(false);
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
    using Reason = autofill::PaymentsUiClosedReason;
    const auto reason = action == "accept"    ? Reason::kAccepted
                        : action == "decline" ? Reason::kCancelled
                        : action == "dismiss" ? Reason::kClosed
                                              : Reason::kNotInteracted;
    if (on_closed_)
      std::move(on_closed_).Run(reason);
  }

 private:
  raw_ptr<autofill::SaveCardBubbleController> controller_;
  base::OnceCallback<void(autofill::PaymentsUiClosedReason)> on_closed_;
};
autofill::AutofillBubbleBase* SaveAddressBubble(
    content::WebContents* page,
    std::unique_ptr<autofill::SaveAddressBubbleController>& controller) {
  return CanHandle(page)
             ? (new SaveAddress(page, std::move(controller)))->Show()
             : nullptr;
}
autofill::AutofillBubbleBase* UpdateAddressBubble(
    content::WebContents* page,
    std::unique_ptr<autofill::UpdateAddressBubbleController>& controller) {
  return CanHandle(page)
             ? (new UpdateAddress(page, std::move(controller)))->Show()
             : nullptr;
}
autofill::AutofillBubbleBase* SaveCardBubble(
    content::WebContents* page,
    autofill::SaveCardBubbleController* controller) {
  using autofill::PaymentsBubbleType;
  return CanHandle(page) && (controller->GetPaymentsBubbleType() ==
                                 PaymentsBubbleType::kLocalSave ||
                             controller->GetPaymentsBubbleType() ==
                                 PaymentsBubbleType::kLocalCvcSave)
             ? (new SaveCard(page, controller))->Show()
             : nullptr;
}
}  // namespace

void FormPrompts::Start(Sink sink, TabGate gate) {
  EventSink() = std::move(sink);
  Gate() = std::move(gate);
  g_bay_webui_password_bubble = &PasswordBubble;
  autofill::g_bay_webui_save_address_bubble = &SaveAddressBubble;
  autofill::g_bay_webui_update_address_bubble = &UpdateAddressBubble;
  autofill::g_bay_webui_save_card_bubble = &SaveCardBubble;
}
std::optional<base::DictValue> FormPrompts::Password(
    content::WebContents* contents) {
  auto model = ModelFor(contents);
  return model ? Password(*model) : std::nullopt;
}
std::optional<base::DictValue> FormPrompts::Password(
    const PasswordsModelDelegate& delegate) {
  const auto* model = &delegate;
  const auto state = PasswordState(model);
  if (state.empty())
    return std::nullopt;
  std::string username, federation;
  int length = 0;
  using password_manager::ui::State;
  if (model->GetState() != State::UPDATE_CONFIRMATION_STATE) {
    const auto& form = model->GetPendingPassword();
    username = UTF8(form.username_value);
    length = static_cast<int>(form.password_value.size());
    if (form.federation_origin.IsValid())
      federation = form.federation_origin.Serialize();
  }
  base::ListValue usernames;
  for (const auto& form : model->GetCurrentForms())
    if (form && !form->username_value.empty())
      usernames.Append(UTF8(form->username_value));
  return base::DictValue()
      .Set("state", state)
      .Set("origin", model->GetOrigin().Serialize())
      .Set("username", username)
      .Set("passwordLength", length)
      .Set("federation", federation)
      .Set("usernames", std::move(usernames));
}
std::optional<base::DictValue> FormPrompts::Autofill(
    content::WebContents* contents) {
  const auto* prompt = Pending(contents);
  return prompt ? std::make_optional(prompt->Payload()) : std::nullopt;
}
bool FormPrompts::IsPasswordActionAllowed(const std::string& state,
                                          const std::string& action) {
  return ((action == "save" || action == "update") &&
          (state == "save" || state == "update")) ||
         (action == "never" && state == "save") ||
         (action == "nope" && state == "update") ||
         (action == "dismiss" && !state.empty());
}
bool FormPrompts::ResolvePassword(content::WebContents* contents,
                                  const std::string& action,
                                  const std::optional<std::string>& username,
                                  const std::optional<std::string>& password) {
  auto model = ModelFor(contents);
  if (!model || !IsPasswordActionAllowed(PasswordState(model.get()), action))
    return false;
  if (action == "save" || action == "update") {
    const auto& pending = model->GetPendingPassword();
    model->SavePassword(
        username && !username->empty() ? base::UTF8ToUTF16(*username)
                                       : pending.username_value,
        password && !password->empty()
            ? password_manager::PasswordString(base::UTF8ToUTF16(*password))
            : pending.password_value);
  } else if (action == "never")
    model->NeverSavePassword();
  else if (action == "nope")
    model->OnNopeUpdateClicked();
  if (model)
    model->OnBubbleHidden();
  return true;
}
bool FormPrompts::ResolveAutofill(content::WebContents* contents,
                                  int id,
                                  const std::string& action) {
  auto* prompt = Pending(contents);
  return prompt && prompt->id() == id && prompt->Answer(action);
}
}  // namespace bay
