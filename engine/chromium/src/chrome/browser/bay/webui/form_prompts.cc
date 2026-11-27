// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/form_prompts.h"

#include <memory>
#include <utility>

#include "bay/core/nn_form_prompts.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/ui/autofill/autofill_bubble_base.h"
#include "chrome/browser/ui/autofill/payments/save_card_bubble_controller.h"
#include "chrome/browser/ui/autofill/payments/save_card_ui.h"
#include "chrome/browser/ui/autofill/save_address_bubble_controller.h"
#include "chrome/browser/ui/autofill/update_address_bubble_controller.h"
#include "chrome/browser/ui/passwords/passwords_model_delegate.h"
#include "content/public/browser/web_contents.h"

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

namespace forms = nncore::forms;

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
bool PasswordBubble(content::WebContents* contents) {
  auto payload = FormPrompts::Password(contents);
  if (!CanHandle(contents) || !payload)
    return false;
  const bool confirmation = *payload->FindString("state") == "saved";
  auto model = forms::PasswordModel(contents);
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
            if (confirmation && model &&
                forms::PasswordState(*model) == "saved")
              model->OnBubbleHidden();
          },
          contents->GetWeakPtr(), model, std::move(*payload), confirmation));
  return true;
}
autofill::AutofillBubbleBase* SaveAddressBubble(
    content::WebContents* page,
    std::unique_ptr<autofill::SaveAddressBubbleController>& controller) {
  return CanHandle(page) ? forms::ShowSaveAddress(page, std::move(controller))
                         : nullptr;
}
autofill::AutofillBubbleBase* UpdateAddressBubble(
    content::WebContents* page,
    std::unique_ptr<autofill::UpdateAddressBubbleController>& controller) {
  return CanHandle(page) ? forms::ShowUpdateAddress(page, std::move(controller))
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
             ? forms::ShowSaveCard(page, controller)
             : nullptr;
}
}  // namespace

void FormPrompts::Start(Sink sink, TabGate gate) {
  EventSink() = std::move(sink);
  Gate() = std::move(gate);
  forms::SetAutofillTell(base::BindRepeating(
      [](content::WebContents* contents, base::DictValue payload) {
        Tell(contents, "onAutofillPrompt", std::move(payload));
      }));
  g_bay_webui_password_bubble = &PasswordBubble;
  autofill::g_bay_webui_save_address_bubble = &SaveAddressBubble;
  autofill::g_bay_webui_update_address_bubble = &UpdateAddressBubble;
  autofill::g_bay_webui_save_card_bubble = &SaveCardBubble;
}
std::optional<base::DictValue> FormPrompts::Password(
    content::WebContents* contents) {
  auto model = forms::PasswordModel(contents);
  return model ? Password(*model) : std::nullopt;
}
std::optional<base::DictValue> FormPrompts::Password(
    const PasswordsModelDelegate& model) {
  return forms::DescribePassword(model);
}
std::optional<base::DictValue> FormPrompts::Autofill(
    content::WebContents* contents) {
  return forms::AutofillPrompt(contents);
}
bool FormPrompts::IsPasswordActionAllowed(const std::string& state,
                                          const std::string& action) {
  return forms::IsPasswordActionAllowed(state, action);
}
bool FormPrompts::ResolvePassword(content::WebContents* contents,
                                  const std::string& action,
                                  const std::optional<std::string>& username,
                                  const std::optional<std::string>& password) {
  return forms::ResolvePassword(contents, action, username, password);
}
bool FormPrompts::ResolveAutofill(content::WebContents* contents,
                                  int id,
                                  const std::string& action) {
  return forms::ResolveAutofill(contents, id, action);
}
}  // namespace bay
