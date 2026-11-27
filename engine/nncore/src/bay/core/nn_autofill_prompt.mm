// The macOS host's side of the shared autofill prompts (nn_form_prompts.cc): the window
// delegate they go to, and the bubbles the host has no UI for.

#include "bay/core/nn_autofill_prompt.h"

#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/ui/autofill/address_bubbles_controller.h"
#include "chrome/browser/ui/autofill/autofill_bubble_base.h"
#include "chrome/browser/ui/autofill/payments/iban_bubble_controller_impl.h"
#include "chrome/browser/ui/autofill/payments/offer_notification_bubble_controller_impl.h"
#include "chrome/browser/ui/autofill/payments/save_card_bubble_controller.h"
#include "chrome/browser/ui/autofill/payments/save_card_bubble_controller_impl.h"
#include "chrome/browser/ui/autofill/payments/save_card_ui.h"
#include "chrome/browser/ui/autofill/save_address_bubble_controller.h"
#include "chrome/browser/ui/autofill/update_address_bubble_controller.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "components/autofill/core/browser/ui/payments/payments_ui_closed_reasons.h"
#include "content/public/browser/web_contents.h"
#import "bay/core/nncore_internal.h"
#include "bay/core/nn_browser.h"
#include "bay/core/nn_form_prompts.h"
#include "bay/core/nn_mac_values.h"

namespace nncore {

namespace {

// To the window showing the tab. Never makes a tab's bridge: a page the host doesn't have
// (or one being destroyed) has none.
void TellWindow(content::WebContents* contents, base::DictValue payload) {
  BrowserWindowInterface* browser =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
  WindowHost* host = browser ? WindowHost::ForBrowser(browser) : nullptr;
  NNCoreWindow* owner = host ? host->owner() : nil;
  id<NNCoreWindowDelegate> delegate = owner.delegate;
  TabBridge* bridge = TabBridge::FromWebContents(contents);
  if (!bridge || ![delegate respondsToSelector:@selector(window:autofillPrompt:forTab:)]) {
    return;
  }
  [delegate window:owner autofillPrompt:NSDictionaryFrom(payload) forTab:bridge->tab()];
}

content::WebContents* Told(content::WebContents* contents) {
  static bool told = [] {
    forms::SetAutofillTell(base::BindRepeating(&TellWindow));
    return true;
  }();
  (void)told;
  return contents;
}

// Bubbles the host has no UI for (the address sign-in promo; Google Pay's upload progress and
// "manage cards", which need its servers or the omnibox icon): closed at once, unanswered, as
// Chrome's are when the user looks away. `close` tells the tab's controller, if this is still
// its bubble.
class SkippedBubble : public autofill::AutofillBubbleBase {
 public:
  using CloseCallback =
      base::OnceCallback<void(content::WebContents*, autofill::AutofillBubbleBase*)>;

  SkippedBubble(content::WebContents* contents, CloseCallback close)
      : contents_(contents->GetWeakPtr()), close_(std::move(close)) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&SkippedBubble::CloseNow, weak_factory_.GetWeakPtr()));
  }

  void Hide() override {
    if (!hidden_) {
      hidden_ = true;
      base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, this);
    }
  }
  bool IsMouseHovered() const override { return false; }

 private:
  void CloseNow() {
    if (hidden_) {
      return;
    }
    hidden_ = true;
    if (contents_) {
      std::move(close_).Run(contents_.get(), this);
    }
    delete this;
  }

  base::WeakPtr<content::WebContents> contents_;
  CloseCallback close_;
  bool hidden_ = false;
  base::WeakPtrFactory<SkippedBubble> weak_factory_{this};
};

}  // namespace

autofill::AutofillBubbleBase* ShowSaveAddressPrompt(
    content::WebContents* contents,
    std::unique_ptr<autofill::SaveAddressBubbleController> controller) {
  return forms::ShowSaveAddress(Told(contents), std::move(controller));
}

autofill::AutofillBubbleBase* ShowUpdateAddressPrompt(
    content::WebContents* contents,
    std::unique_ptr<autofill::UpdateAddressBubbleController> controller) {
  return forms::ShowUpdateAddress(Told(contents), std::move(controller));
}

autofill::AutofillBubbleBase* ShowSaveCardPrompt(content::WebContents* contents,
                                                 autofill::SaveCardBubbleController* controller) {
  using autofill::PaymentsBubbleType;
  switch (controller->GetPaymentsBubbleType()) {
    case PaymentsBubbleType::kLocalSave:
    case PaymentsBubbleType::kLocalCvcSave:
      return forms::ShowSaveCard(Told(contents), controller);
    default:
      // Saving to Google Pay (it needs a Google account, which the app has none of), its
      // progress, and "manage cards" (the omnibox icon's).
      return new SkippedBubble(
          contents, base::BindOnce([](content::WebContents* contents,
                                      autofill::AutofillBubbleBase* bubble) {
            auto* controller = autofill::SaveCardBubbleControllerImpl::FromWebContents(contents);
            if (controller && controller->GetPaymentBubbleView() == bubble) {
              controller->OnBubbleClosed(autofill::PaymentsUiClosedReason::kNotInteracted);
            }
          }));
  }
}

autofill::AutofillBubbleBase* SkipIbanBubble(content::WebContents* contents) {
  return new SkippedBubble(
      contents,
      base::BindOnce([](content::WebContents* contents, autofill::AutofillBubbleBase* bubble) {
        auto* controller = autofill::IbanBubbleControllerImpl::FromWebContents(contents);
        if (controller && controller->GetPaymentBubbleView() == bubble) {
          controller->OnBubbleClosed(autofill::PaymentsUiClosedReason::kNotInteracted);
        }
      }));
}

autofill::AutofillBubbleBase* SkipOfferNotification(content::WebContents* contents) {
  return new SkippedBubble(
      contents,
      base::BindOnce([](content::WebContents* contents, autofill::AutofillBubbleBase* bubble) {
        auto* controller =
            autofill::OfferNotificationBubbleControllerImpl::FromWebContents(contents);
        if (controller && controller->GetOfferNotificationBubbleView() == bubble) {
          controller->OnBubbleClosed(autofill::PaymentsUiClosedReason::kNotInteracted);
        }
      }));
}

autofill::AutofillBubbleBase* SkipAddressSignInPromo(content::WebContents* contents) {
  return new SkippedBubble(
      contents,
      base::BindOnce([](content::WebContents* contents, autofill::AutofillBubbleBase* bubble) {
        auto* controller = autofill::AddressBubblesController::FromWebContents(contents);
        if (controller && controller->GetBubbleView() == bubble) {
          controller->OnBubbleClosed();
        }
      }));
}

NSDictionary<NSString*, id>* AutofillPrompt(content::WebContents* contents) {
  std::optional<base::DictValue> prompt = forms::AutofillPrompt(contents);
  return prompt ? NSDictionaryFrom(*prompt) : nil;
}

void ResolveAutofillPrompt(content::WebContents* contents, NSInteger prompt_id, NSString* action) {
  forms::ResolveAutofill(contents, static_cast<int>(prompt_id), base::SysNSStringToUTF8(action));
}

}  // namespace nncore
