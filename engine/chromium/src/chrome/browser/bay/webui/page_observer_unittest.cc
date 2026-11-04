// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_observer.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/test/bind.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/web_contents.h"
#include "content/public/test/web_contents_tester.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace bay {
namespace {
class PageObserverTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    sessions::SessionTabHelper::CreateForWebContents(
        web_contents(), base::BindRepeating([](content::WebContents*)
            -> sessions::SessionTabHelperDelegate* { return nullptr; }));
    NavigateAndCommit(GURL("https://before.test/"));
    observer_ = std::make_unique<TabObserver>(
        web_contents(), base::BindLambdaForTesting(
            [this](const char* event, base::DictValue payload) {
              events_.emplace_back(event, std::move(payload));
            }));
    observer_->State();
    events_.clear();
  }
  void TearDown() override {
    observer_.reset();
    replacement_.reset();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  size_t Count(const char* event) const {
    size_t count = 0;
    for (const auto& entry : events_)
      if (entry.first == event)
        ++count;
    return count;
  }
  const base::DictValue& Last(const char* event) const {
    for (auto entry = events_.rbegin(); entry != events_.rend(); ++entry)
      if (entry->first == event)
        return entry->second;
    ADD_FAILURE() << "Missing " << event;
    return empty_;
  }
  std::unique_ptr<TabObserver> observer_;
  std::unique_ptr<content::WebContents> replacement_;
  std::vector<std::pair<std::string, base::DictValue>> events_;
  const base::DictValue empty_;
};

TEST_F(PageObserverTest, InPlaceDiscardEmitsOneDiscardAndOneReadyOnWakeup) {
  web_contents()->NotifyWasDiscarded();
  EXPECT_TRUE(observer_->discarded());
  EXPECT_EQ(Count("onDiscarded"), 1u);
  EXPECT_EQ(*Last("onDiscarded").FindString("url"), "https://before.test/");
  observer_->State();
  EXPECT_EQ(Count("onDiscarded"), 1u);
  EXPECT_EQ(Count("onReady"), 0u);
  content::WebContentsTester::For(web_contents())->TestSetIsLoading(true);
  EXPECT_FALSE(observer_->discarded());
  ASSERT_EQ(Count("onReady"), 1u);
  const int id = sessions::SessionTabHelper::IdForTab(web_contents()).id();
  EXPECT_EQ(Last("onReady").FindInt("browserId"), id);
  EXPECT_EQ(Last("onReady").FindInt("tabId"), id);
  observer_->State();
  content::WebContentsTester::For(web_contents())->TestSetIsLoading(false);
  content::WebContentsTester::For(web_contents())->TestSetIsLoading(true);
  EXPECT_EQ(Count("onReady"), 1u);
  EXPECT_EQ(Count("onDiscarded"), 1u);
}

TEST_F(PageObserverTest, ReplacementReplaysNewContentsWithoutPrematureReady) {
  replacement_ =
      content::WebContentsTester::CreateTestWebContents(profile(), nullptr);
  sessions::SessionTabHelper::CreateForWebContents(
      replacement_.get(), base::BindRepeating([](content::WebContents*)
          -> sessions::SessionTabHelperDelegate* { return nullptr; }));
  content::WebContentsTester::For(replacement_.get())
      ->NavigateAndCommit(GURL("https://replacement.test/"));
  observer_->ReplaceContents(replacement_.get());
  EXPECT_EQ(observer_->contents(), replacement_.get());
  EXPECT_TRUE(observer_->discarded());
  EXPECT_EQ(Count("onReady"), 0u);
  observer_->State();
  EXPECT_EQ(*Last("onNavigationChange").FindString("url"),
            "https://replacement.test/");
  EXPECT_EQ(*Last("onDiscarded").FindString("url"),
            "https://replacement.test/");
  EXPECT_EQ(Count("onDiscarded"), 1u);
  EXPECT_EQ(Count("onReady"), 0u);
  observer_->State();
  EXPECT_EQ(Count("onDiscarded"), 1u);
  // Notifications from the retired page cannot wake the replacement.
  content::WebContentsTester::For(web_contents())->TestSetIsLoading(true);
  EXPECT_EQ(Count("onReady"), 0u);
  content::WebContentsTester::For(replacement_.get())->TestSetIsLoading(true);
  ASSERT_EQ(Count("onReady"), 1u);
  const int id = sessions::SessionTabHelper::IdForTab(replacement_.get()).id();
  EXPECT_EQ(Last("onReady").FindInt("browserId"), id);
  EXPECT_EQ(Last("onReady").FindInt("tabId"), id);
  observer_->State();
  EXPECT_EQ(Count("onReady"), 1u);
}
}  // namespace
}  // namespace bay
