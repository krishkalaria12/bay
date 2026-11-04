// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/form_prompts.h"

#include "base/functional/bind.h"
#include "base/test/bind.h"
#include "chrome/browser/ui/autofill/address_bubble_controller_delegate.h"
#include "chrome/browser/ui/autofill/autofill_bubble_base.h"
#include "chrome/browser/ui/autofill/chrome_autofill_client.h"
#include "chrome/browser/ui/autofill/save_address_bubble_controller.h"
#include "chrome/browser/ui/passwords/passwords_model_delegate_mock.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "components/autofill/core/browser/data_model/addresses/autofill_profile.h"
#include "components/autofill/core/browser/foundations/autofill_client.h"
#include "components/password_manager/core/browser/password_form.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/origin.h"

namespace autofill {
extern AutofillBubbleBase* (*g_bay_webui_save_address_bubble)(
    content::WebContents*,
    std::unique_ptr<SaveAddressBubbleController>&);
}
namespace bay {
namespace {
using Decision = autofill::AutofillClient::AddressPromptUserDecision;
class AddressDelegate : public autofill::AddressBubbleControllerDelegate {
 public:
  void ShowEditor(const autofill::AutofillProfile&,
                  const std::u16string&,
                  const std::u16string&,
                  bool) override {}
  void OnUserDecision(
      Decision value,
      base::optional_ref<const autofill::AutofillProfile>) override {
    decision = value;
  }
  void OnBubbleClosed() override { ++closed; }
  base::WeakPtr<autofill::AddressBubbleControllerDelegate> GetWeakPtr() {
    return weak_.GetWeakPtr();
  }
  std::optional<Decision> decision;
  int closed = 0;

 private:
  base::WeakPtrFactory<AddressDelegate> weak_{this};
};
class FormPromptsTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    autofill::ChromeAutofillClient::CreateForWebContents(web_contents());
    FormPrompts::Start(
        base::BindLambdaForTesting([this](content::WebContents* page,
                                          const char* event,
                                          base::DictValue payload) {
          EXPECT_EQ(page, web_contents());
          EXPECT_EQ(std::string(event), "onAutofillPrompt");
          events_.Append(std::move(payload));
        }),
        base::BindLambdaForTesting([this](content::WebContents* page) {
          return allowed_ && page == web_contents();
        }));
  }
  void TearDown() override {
    if (auto prompt = FormPrompts::Autofill(web_contents()))
      FormPrompts::ResolveAutofill(web_contents(), *prompt->FindInt("id"),
                                   "dismiss");
    task_environment()->RunUntilIdle();
    FormPrompts::Start({});
    ChromeRenderViewHostTestHarness::TearDown();
  }
  autofill::AutofillBubbleBase* Show() {
    autofill::AutofillProfile profile(autofill::AddressCountryCode("US"));
    profile.SetRawInfo(autofill::NAME_FULL, u"Ada Lovelace");
    auto controller = std::make_unique<autofill::SaveAddressBubbleController>(
        delegate_.GetWeakPtr(), web_contents(), profile,
        autofill::AutofillClient::SaveAddressBubbleType::kSave);
    return autofill::g_bay_webui_save_address_bubble(web_contents(),
                                                     controller);
  }
  bool allowed_ = true;
  AddressDelegate delegate_;
  base::ListValue events_;
};

TEST_F(FormPromptsTest, OfferWaitsForChromeToOwnTheBubbleAndAnswersOnce) {
  ASSERT_TRUE(Show());
  EXPECT_TRUE(events_.empty());
  task_environment()->RunUntilIdle();
  ASSERT_EQ(events_.size(), 1u);
  const auto& payload = events_[0].GetDict();
  EXPECT_EQ(*payload.FindString("kind"), "saveAddress");
  EXPECT_FALSE(payload.contains("password"));
  const int id = *payload.FindInt("id");
  EXPECT_FALSE(FormPrompts::ResolveAutofill(web_contents(), id + 1, "accept"));
  EXPECT_FALSE(FormPrompts::ResolveAutofill(web_contents(), id, "invalid"));
  EXPECT_EQ(delegate_.closed, 0);
  EXPECT_TRUE(FormPrompts::ResolveAutofill(web_contents(), id, "accept"));
  EXPECT_EQ(delegate_.decision, Decision::kAccepted);
  EXPECT_EQ(delegate_.closed, 1);
  EXPECT_FALSE(FormPrompts::ResolveAutofill(web_contents(), id, "accept"));
  ASSERT_EQ(events_.size(), 2u);
  EXPECT_EQ(events_[1].GetDict().FindBool("closed"), true);
}
TEST_F(FormPromptsTest, ChromeHideClosesWithoutInventingAUserDecision) {
  auto* bubble = Show();
  ASSERT_TRUE(bubble);
  const auto before = FormPrompts::Autofill(web_contents());
  ASSERT_TRUE(before);
  bubble->Hide();
  bubble->Hide();
  EXPECT_FALSE(delegate_.decision);
  EXPECT_EQ(delegate_.closed, 1);
  EXPECT_FALSE(FormPrompts::Autofill(web_contents()));
  task_environment()->RunUntilIdle();
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(events_[0].GetDict().FindBool("closed"), true);
}
TEST_F(FormPromptsTest, UnownedTabLeavesTheChromeControllerUntouched) {
  allowed_ = false;
  EXPECT_FALSE(Show());
  EXPECT_FALSE(FormPrompts::Autofill(web_contents()));
  EXPECT_EQ(delegate_.closed, 0);
  EXPECT_FALSE(delegate_.decision);
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(events_.empty());
}
TEST_F(FormPromptsTest, ReplacedOfferCannotBeAnsweredWithAnOldId) {
  ASSERT_TRUE(Show());
  const int old = *FormPrompts::Autofill(web_contents())->FindInt("id");
  ASSERT_TRUE(Show());
  const int current = *FormPrompts::Autofill(web_contents())->FindInt("id");
  EXPECT_NE(old, current);
  EXPECT_EQ(delegate_.closed, 1);
  EXPECT_FALSE(FormPrompts::ResolveAutofill(web_contents(), old, "accept"));
  EXPECT_TRUE(FormPrompts::ResolveAutofill(web_contents(), current, "decline"));
  EXPECT_EQ(delegate_.closed, 2);
}
TEST(FormPasswordPayload, ExposesDisplayFieldsWithoutTheSavedSecret) {
  testing::NiceMock<PasswordsModelDelegateMock> model;
  password_manager::PasswordForm pending;
  pending.username_value = u"person@example.test";
  pending.password_value = password_manager::PasswordString(u"private-secret");
  std::vector<std::unique_ptr<password_manager::PasswordForm>> forms;
  forms.push_back(std::make_unique<password_manager::PasswordForm>());
  forms.back()->username_value = u"alternate@example.test";
  ON_CALL(model, GetState())
      .WillByDefault(
          testing::Return(password_manager::ui::PENDING_PASSWORD_STATE));
  ON_CALL(model, GetOrigin())
      .WillByDefault(
          testing::Return(url::Origin::Create(GURL("https://example.test/"))));
  ON_CALL(model, GetPendingPassword())
      .WillByDefault(testing::ReturnRef(pending));
  ON_CALL(model, GetCurrentForms()).WillByDefault(testing::ReturnRef(forms));
  const auto payload = FormPrompts::Password(model);
  ASSERT_TRUE(payload);
  EXPECT_EQ(*payload->FindString("state"), "save");
  EXPECT_EQ(*payload->FindString("origin"), "https://example.test");
  EXPECT_EQ(*payload->FindString("username"), "person@example.test");
  EXPECT_EQ(payload->FindInt("passwordLength"), 14);
  EXPECT_FALSE(payload->contains("password"));
  ASSERT_EQ(payload->FindList("usernames")->size(), 1u);
  EXPECT_EQ((*payload->FindList("usernames"))[0].GetString(),
            "alternate@example.test");
  ON_CALL(model, GetState())
      .WillByDefault(testing::Return(password_manager::ui::MANAGE_STATE));
  EXPECT_FALSE(FormPrompts::Password(model));
}

TEST(FormPasswordActions, RejectsStaleOrIncompatibleAnswers) {
  for (const auto& state : {"", "saved"}) {
    for (const auto& action : {"save", "update", "never", "nope"})
      EXPECT_FALSE(FormPrompts::IsPasswordActionAllowed(state, action));
  }
  EXPECT_TRUE(FormPrompts::IsPasswordActionAllowed("save", "save"));
  EXPECT_TRUE(FormPrompts::IsPasswordActionAllowed("update", "update"));
  EXPECT_TRUE(FormPrompts::IsPasswordActionAllowed("save", "never"));
  EXPECT_FALSE(FormPrompts::IsPasswordActionAllowed("update", "never"));
  EXPECT_TRUE(FormPrompts::IsPasswordActionAllowed("update", "nope"));
  EXPECT_FALSE(FormPrompts::IsPasswordActionAllowed("save", "nope"));
  EXPECT_FALSE(FormPrompts::IsPasswordActionAllowed("save", "unknown"));
  EXPECT_TRUE(FormPrompts::IsPasswordActionAllowed("save", "dismiss"));
  EXPECT_FALSE(FormPrompts::ResolvePassword(nullptr, "save", {}, {}));
}
}  // namespace
}  // namespace bay
