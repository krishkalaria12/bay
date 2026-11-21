// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_interaction_events.h"

#include <memory>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/memory/raw_ptr.h"
#include "base/test/scoped_feature_list.h"
#include "base/test/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/test/test_future.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "components/blocked_content/popup_blocker_tab_helper.h"
#include "components/blocked_content/popup_navigation_delegate.h"
#include "components/blocked_content/safe_browsing_triggered_popup_blocker.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/content_settings/core/common/content_settings_types.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/test/mock_navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/mojom/window_features/window_features.mojom.h"
#include "url/gurl.h"

namespace bay {
namespace {
// CEF's base patch adds a priority argument; its stock mock does not. Hold
// throttles without registering them with a live load.
class Registry final : public content::NavigationThrottleRegistry {
 public:
  explicit Registry(content::NavigationHandle* handle) : handle_(handle) {}
  content::NavigationHandle& GetNavigationHandle() override { return *handle_; }
  void AddThrottle(std::unique_ptr<content::NavigationThrottle> throttle,
                   bool = false) override {
    throttles_.push_back(std::move(throttle));
  }
  bool HasThrottle(const std::string&) override { return false; }
  bool EraseThrottleForTesting(const std::string&) override { return false; }
  std::vector<std::unique_ptr<content::NavigationThrottle>> throttles_;
 private:
  const raw_ptr<content::NavigationHandle> handle_;
};
class Popup final : public blocked_content::PopupNavigationDelegate {
 public:
  Popup(GURL url, bool* opened) : url_(std::move(url)), opened_(opened) {}
  content::RenderFrameHost* GetOpener() override { return nullptr; }
  bool GetOriginalUserGesture() override { return false; }
  GURL GetURL() override { return url_; }
  NavigateResult NavigateWithGesture(
      const blink::mojom::WindowFeatures&,
      std::optional<WindowOpenDisposition> disposition) override {
    EXPECT_EQ(disposition, WindowOpenDisposition::NEW_FOREGROUND_TAB);
    *opened_ = true;
    return {};
  }
  void OnPopupBlocked(content::WebContents*, int) override {}
 private:
  const GURL url_;
  const raw_ptr<bool> opened_;
};
class PageInteractionEventsTest : public ChromeRenderViewHostTestHarness {
 protected:
  PageInteractionEventsTest() {
    features_.InitAndDisableFeature(blocked_content::kAbusiveExperienceEnforce);
  }
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    NavigateAndCommit(GURL("https://source.example/page"));
    blocked_content::PopupBlockerTabHelper::CreateForWebContents(web_contents());
    helper_ = std::make_unique<PageInteractionEvents>(web_contents(),
        base::BindLambdaForTesting([this](const char* name, base::DictValue payload) {
          events_.Append(base::DictValue().Set("event", name)
                                         .Set("payload", std::move(payload)));
        }));
    helper_->State();
    events_.clear();
  }
  void TearDown() override {
    helper_.reset();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  blocked_content::PopupBlockerTabHelper* popups() {
    return blocked_content::PopupBlockerTabHelper::FromWebContents(web_contents());
  }
  void Block(bool* opened) {
    popups()->AddBlockedPopup(
        std::make_unique<Popup>(GURL("https://popup.example/form"), opened),
        blink::mojom::WindowFeatures(), blocked_content::PopupBlockType::kNoGesture);
  }
  std::string Open(const std::string& id, base::Value always = {}) {
    base::test::TestFuture<const std::string&> reply;
    auto callback = reply.GetCallback();
    EXPECT_TRUE(PageInteractionEvents::Dispatch(
        web_contents(), "openBlockedPopup",
        base::ListValue().Append(id).Append(std::move(always)), callback));
    return reply.Get();
  }
  base::test::ScopedFeatureList features_;
  std::unique_ptr<PageInteractionEvents> helper_;
  base::ListValue events_;
};
TEST_F(PageInteractionEventsTest, HoverTextChangesAndNavigationClearsIt) {
  EXPECT_TRUE(PageInteractionEvents::TargetURL(web_contents(), GURL("https://target.example/")));
  EXPECT_TRUE(PageInteractionEvents::TargetURL(web_contents(), GURL("https://target.example/")));
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(*events_[0].GetDict().FindStringByDottedPath("payload.text"), "https://target.example/");
  NavigateAndCommit(GURL("https://source.example/next"));
  ASSERT_EQ(events_.size(), 2u);
  EXPECT_EQ(*events_[1].GetDict().FindStringByDottedPath("payload.text"), "");
  helper_.reset();
  EXPECT_FALSE(PageInteractionEvents::TargetURL(web_contents(), GURL("https://target.example/")));
}
TEST_F(PageInteractionEventsTest, PopupEventIsDeferredAndPreservesChromeRequest) {
  bool opened = false;
  Block(&opened);
  EXPECT_TRUE(events_.empty());
  task_environment()->RunUntilIdle();
  ASSERT_EQ(events_.size(), 1u);
  const auto& popup = events_[0].GetDict();
  EXPECT_EQ(*popup.FindString("event"), "onPopupBlocked");
  EXPECT_EQ(*popup.FindStringByDottedPath("payload.origin"), "https://source.example");
  EXPECT_EQ(*popup.FindStringByDottedPath("payload.url"), "https://popup.example/form");
  const auto id = *popup.FindStringByDottedPath("payload.id");
  EXPECT_EQ(Open("forged", base::Value(true)), R"({"value":null})");
  EXPECT_FALSE(opened);
  EXPECT_EQ(Open(id), R"({"value":null})");
  EXPECT_TRUE(opened);
  EXPECT_TRUE(popups()->GetBlockedPopupRequests().empty());
}
TEST_F(PageInteractionEventsTest, OnlyValidRetainedPopupCanChangeOriginPermission) {
  auto* map = HostContentSettingsMapFactory::GetForProfile(profile());
  const GURL origin("https://source.example/");
  Open("9999", base::Value(true));
  EXPECT_NE(map->GetContentSetting(origin, origin, ContentSettingsType::POPUPS), CONTENT_SETTING_ALLOW);
  bool opened = false;
  Block(&opened);
  const auto id = base::NumberToString(popups()->GetBlockedPopupRequests().begin()->first);
  Open(id, base::Value(true));
  EXPECT_TRUE(opened);
  EXPECT_EQ(map->GetContentSetting(origin, origin, ContentSettingsType::POPUPS), CONTENT_SETTING_ALLOW);
}
TEST_F(PageInteractionEventsTest, NavigationDropsQueuedPopupAndStaleOpen) {
  bool opened = false;
  Block(&opened);
  const auto id = base::NumberToString(popups()->GetBlockedPopupRequests().begin()->first);
  NavigateAndCommit(GURL("https://other.example/"));
  task_environment()->RunUntilIdle();
  for (const auto& event : events_)
    EXPECT_NE(*event.GetDict().FindString("event"), "onPopupBlocked");
  Open(id);
  EXPECT_FALSE(opened);
}
TEST_F(PageInteractionEventsTest, PeekInterceptsClickedCrossSiteLinksAndRedirects) {
  PageInteractionEvents::SetPeekLinks(web_contents(), true);
  content::MockNavigationHandle handle(GURL("https://source.example/redirect"), main_rfh());
  handle.set_page_transition(ui::PAGE_TRANSITION_LINK);
  ON_CALL(handle, HasUserGesture()).WillByDefault(testing::Return(true));
  Registry registry(&handle);
  AddPageInteractionThrottles(registry);
  ASSERT_EQ(registry.throttles_.size(), 1u);
  auto* throttle = registry.throttles_[0].get();
  EXPECT_EQ(throttle->WillStartRequest().action(), content::NavigationThrottle::PROCEED);
  handle.set_url(GURL("https://other.example/landing"));
  EXPECT_EQ(throttle->WillRedirectRequest().action(), content::NavigationThrottle::CANCEL_AND_IGNORE);
  EXPECT_TRUE(events_.empty());
  task_environment()->RunUntilIdle();
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(*events_[0].GetDict().FindString("event"), "onPeekLink");
  EXPECT_EQ(*events_[0].GetDict().FindStringByDottedPath("payload.url"), "https://other.example/landing");
}
TEST_F(PageInteractionEventsTest, PeekSettingSurvivesObserverHandoffButDisablesQueuedPeek) {
  PageInteractionEvents::SetPeekLinks(web_contents(), true);
  helper_.reset();
  EXPECT_FALSE(PageInteractionEvents::PeekLinksEnabled(web_contents()));
  helper_ = std::make_unique<PageInteractionEvents>(web_contents(),
      base::BindRepeating([](const char*, base::DictValue) {}));
  EXPECT_TRUE(PageInteractionEvents::PeekLinksEnabled(web_contents()));
  PageInteractionEvents::SetPeekLinks(web_contents(), false);
  EXPECT_FALSE(PageInteractionEvents::PeekLinksEnabled(web_contents()));
}
TEST_F(PageInteractionEventsTest, QueuedPeekDoesNotSurviveDisableOrAnotherDocument) {
  for (const bool navigate : {false, true}) {
    events_.clear();
    PageInteractionEvents::SetPeekLinks(web_contents(), true);
    content::MockNavigationHandle handle(GURL("https://other.example/"), main_rfh());
    handle.set_page_transition(ui::PAGE_TRANSITION_LINK);
    ON_CALL(handle, HasUserGesture()).WillByDefault(testing::Return(true));
    Registry registry(&handle);
    AddPageInteractionThrottles(registry);
    ASSERT_EQ(registry.throttles_.size(), 1u);
    EXPECT_EQ(registry.throttles_[0]->WillStartRequest().action(),
              content::NavigationThrottle::CANCEL_AND_IGNORE);
    if (navigate)
      NavigateAndCommit(GURL("https://source.example/new-document"));
    else
      PageInteractionEvents::SetPeekLinks(web_contents(), false);
    task_environment()->RunUntilIdle();
    for (const auto& event : events_)
      EXPECT_NE(*event.GetDict().FindString("event"), "onPeekLink");
  }
}
TEST(PageInteractionRules, BrowserAndScriptNavigationsDoNotPeek) {
  using P = PageInteractionEvents;
  EXPECT_TRUE(P::IsPeekNavigation(true, true, true, ui::PAGE_TRANSITION_LINK));
  EXPECT_FALSE(P::IsPeekNavigation(false, true, true, ui::PAGE_TRANSITION_LINK));
  EXPECT_FALSE(P::IsPeekNavigation(true, false, true, ui::PAGE_TRANSITION_LINK));
  EXPECT_FALSE(P::IsPeekNavigation(true, true, false, ui::PAGE_TRANSITION_LINK));
  for (const auto transition : {ui::PAGE_TRANSITION_TYPED, ui::PAGE_TRANSITION_FORM_SUBMIT,
                                ui::PAGE_TRANSITION_RELOAD, ui::PAGE_TRANSITION_AUTO_BOOKMARK,
                                static_cast<ui::PageTransition>(ui::PAGE_TRANSITION_LINK | ui::PAGE_TRANSITION_FORWARD_BACK)})
    EXPECT_FALSE(P::IsPeekNavigation(true, true, true, transition));
  EXPECT_FALSE(P::CrossSitePeekURL(GURL("https://a.example.com/"), GURL("https://b.example.com/")));
  EXPECT_FALSE(P::CrossSitePeekURL(GURL("https://source.example/"), GURL("javascript:void 0")));
  EXPECT_TRUE(P::CrossSitePeekURL(GURL("https://one.github.io/"), GURL("https://two.github.io/")));
}
}  // namespace
}  // namespace bay
