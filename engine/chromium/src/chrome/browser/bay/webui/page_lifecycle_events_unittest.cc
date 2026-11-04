// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_lifecycle_events.h"

#include <string>

#include "base/functional/bind.h"
#include "base/test/bind.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/web_contents.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace bay {
namespace {
class PageLifecycleEventsTest : public ChromeRenderViewHostTestHarness {
 protected:
  void TearDown() override {
    PageLifecycleEvents::Start({});
    TabBroker::Get().SetContentsReplacedCallback({});
    ChromeRenderViewHostTestHarness::TearDown();
  }
};

TEST_F(PageLifecycleEventsTest, NativeActivationReachesOnlyTheAcceptedView) {
  int delivered = 0;
  bool accept = false;
  PageLifecycleEvents::Start(base::BindLambdaForTesting(
      [&](content::WebContents* contents, const char* event,
          base::DictValue payload) {
        EXPECT_EQ(contents, web_contents());
        EXPECT_EQ(std::string(event), "onActivateRequest");
        EXPECT_EQ(*payload.FindString("reason"), "page");
        ++delivered;
        return accept;
      }));
  // A regular Chrome page with no Bay mount falls through to native Chrome.
  EXPECT_FALSE(PageLifecycleEvents::RequestActivation(web_contents()));
  accept = true;
  EXPECT_TRUE(PageLifecycleEvents::RequestActivation(web_contents()));
  EXPECT_EQ(delivered, 2);
  EXPECT_FALSE(PageLifecycleEvents::RequestActivation(nullptr));
}

TEST_F(PageLifecycleEventsTest, ActivationDuringAMountHandoffReplaysOnce) {
  auto offer = TabBroker::Get().Offer(web_contents(), false);
  ASSERT_FALSE(offer.adopt_id.empty());
  int delivered = 0;
  bool accept = false;
  PageLifecycleEvents::Start(base::BindLambdaForTesting(
      [&](content::WebContents*, const char*, base::DictValue) {
        if (accept)
          ++delivered;
        return accept;
      }));
  EXPECT_TRUE(PageLifecycleEvents::RequestActivation(web_contents()));
  EXPECT_TRUE(PageLifecycleEvents::RequestActivation(web_contents()));
  accept = true;
  PageLifecycleEvents::Replay(web_contents());
  PageLifecycleEvents::Replay(web_contents());
  EXPECT_EQ(delivered, 1);
  TabBroker::Get().ReleaseOffer(offer.adopt_id);
}

TEST_F(PageLifecycleEventsTest, AViewMayCloseDuringActivationWithoutNativeFallback) {
  PageLifecycleEvents::Start(base::BindLambdaForTesting(
      [&](content::WebContents*, const char*, base::DictValue) {
        DeleteContents();
        return false;
      }));
  EXPECT_TRUE(PageLifecycleEvents::RequestActivation(web_contents()));
}

TEST_F(PageLifecycleEventsTest, DiscardRetainsTheOfferAndRekeysItsContents) {
  auto offer = TabBroker::Get().Offer(web_contents(), false);
  ASSERT_FALSE(offer.adopt_id.empty());
  content::WebContents* original = web_contents();
  auto replacement = content::WebContents::Create(
      content::WebContents::CreateParams(profile()));
  int replacements = 0;
  TabBroker::Get().SetContentsReplacedCallback(base::BindLambdaForTesting(
      [&](content::WebContents* before, content::WebContents* after,
          uint64_t lease) {
        EXPECT_EQ(before, original);
        EXPECT_EQ(after, replacement.get());
        EXPECT_EQ(lease, 0u);
        EXPECT_FALSE(TabBroker::Get().Tracks(before));
        EXPECT_TRUE(TabBroker::Get().Tracks(after));
        ++replacements;
      }));
  original->AboutToBeDiscarded(replacement.get());
  EXPECT_EQ(replacements, 1);
  DeleteContents();
  EXPECT_TRUE(TabBroker::Get().Tracks(replacement.get()));
  TabBroker::Get().ReleaseOffer(offer.adopt_id);
  EXPECT_FALSE(TabBroker::Get().Tracks(replacement.get()));
}

TEST_F(PageLifecycleEventsTest, InPlaceDiscardDoesNotReplaceOrLoseItsEntry) {
  auto offer = TabBroker::Get().Offer(web_contents(), false);
  ASSERT_FALSE(offer.adopt_id.empty());
  int replacements = 0;
  TabBroker::Get().SetContentsReplacedCallback(base::BindLambdaForTesting(
      [&](content::WebContents*, content::WebContents*, uint64_t) {
        ++replacements;
      }));
  web_contents()->AboutToBeDiscarded(web_contents());
  EXPECT_EQ(replacements, 0);
  EXPECT_TRUE(TabBroker::Get().Tracks(web_contents()));
  TabBroker::Get().ReleaseOffer(offer.adopt_id);
}

TEST_F(PageLifecycleEventsTest, AppURLRequiresTheOriginalProfileAndInternalPage) {
  sessions::SessionTabHelper::CreateForWebContents(
      web_contents(), base::BindRepeating([](content::WebContents*)
          -> sessions::SessionTabHelperDelegate* { return nullptr; }));
  NavigateAndCommit(GURL("chrome://version/"));
  auto offer = TabBroker::Get().Offer(web_contents(), false);
  ASSERT_FALSE(offer.adopt_id.empty());
  int delivered = 0;
  PageLifecycleEvents::Start(base::BindLambdaForTesting(
      [&](content::WebContents* contents, const char* event,
          base::DictValue payload) {
        EXPECT_EQ(contents, web_contents());
        EXPECT_EQ(std::string(event), "onOpenWindow");
        EXPECT_EQ(*payload.FindString("url"), "bay://settings/");
        EXPECT_EQ(*payload.FindString("disposition"), "current");
        EXPECT_EQ(payload.FindBool("userGesture"), true);
        ++delivered;
        return true;
      }));
  auto payload = base::DictValue()
      .Set("browserId", sessions::SessionTabHelper::IdForTab(web_contents()).id())
      .Set("profile", profile()->GetOriginalProfile()->GetPath().AsUTF8Unsafe())
      .Set("url", "bay://settings/")
      .Set("userGesture", true);
  EXPECT_FALSE(PageLifecycleEvents::HandleEngineEvent("tabs.other", payload));
  EXPECT_TRUE(PageLifecycleEvents::HandleEngineEvent("tabs.appURL", payload));
  EXPECT_EQ(delivered, 1);
  auto wrong_profile = payload.Clone();
  wrong_profile.Set("profile", "/some/other/profile");
  EXPECT_TRUE(
      PageLifecycleEvents::HandleEngineEvent("tabs.appURL", wrong_profile));
  auto wrong_url = payload.Clone();
  wrong_url.Set("url", "https://example.test/");
  EXPECT_TRUE(PageLifecycleEvents::HandleEngineEvent("tabs.appURL", wrong_url));
  auto wrong_id = payload.Clone();
  wrong_id.Set("browserId", 0);
  EXPECT_TRUE(PageLifecycleEvents::HandleEngineEvent("tabs.appURL", wrong_id));
  NavigateAndCommit(GURL("https://example.test/"));
  EXPECT_TRUE(PageLifecycleEvents::HandleEngineEvent("tabs.appURL", payload));
  EXPECT_EQ(delivered, 1);
  TabBroker::Get().ReleaseOffer(offer.adopt_id);
}
}  // namespace
}  // namespace bay
