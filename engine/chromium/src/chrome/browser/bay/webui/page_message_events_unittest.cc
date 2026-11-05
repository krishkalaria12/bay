// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_message_events.h"

#include <cmath>
#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/test/test_future.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/content_settings/core/common/content_settings_types.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/test/navigation_simulator.h"
#include "content/public/test/test_renderer_host.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
class PageMessageEventsTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    NavigateAndCommit(GURL("https://example.test/page"));
    PageMessageEvents::Start(base::BindRepeating(
        [](std::vector<std::pair<std::string, base::DictValue>>* events,
           content::WebContents*, const char* name, base::DictValue value) {
          events->emplace_back(name, std::move(value));
          return true;
        }, &events_));
  }
  void TearDown() override {
    PageMessageEvents::Start({});
    ChromeRenderViewHostTestHarness::TearDown();
  }
  void Post(const std::string& kind, const std::string& json,
            content::RenderFrameHost* frame = nullptr) {
    auto value = base::JSONReader::Read(json, base::JSON_PARSE_RFC);
    ASSERT_TRUE(value);
    PageMessageEvents::Handle(web_contents(), frame ? frame : main_rfh(), kind,
                               *value);
  }
  std::string Dispatch(const std::string& command, base::ListValue args) {
    base::test::TestFuture<const std::string&> result;
    auto response = result.GetCallback();
    EXPECT_TRUE(PageMessageEvents::Dispatch(web_contents(), command, args,
                                             response));
    return result.Get();
  }
  content::RenderFrameHost* Child() {
    auto* child = content::RenderFrameHostTester::For(main_rfh())->AppendChild("child");
    return content::NavigationSimulator::NavigateAndCommitFromDocument(
        GURL("https://child.test/"), child);
  }
  void AllowNotifications() {
    HostContentSettingsMapFactory::GetForProfile(profile())
        ->SetContentSettingDefaultScope(GURL("https://example.test/"),
                                         GURL("https://example.test/"),
                                         ContentSettingsType::NOTIFICATIONS,
                                         CONTENT_SETTING_ALLOW);
  }
  std::vector<std::pair<std::string, base::DictValue>> events_;
};

TEST_F(PageMessageEventsTest, FiltersSelectionAndOtherMainFrameMessages) {
  Post("selection", R"({"text":"a selected passage","rect":{"x":1,"y":2,"width":3,"height":4},"secret":"ignored"})");
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(events_[0].first, "onPageMessage");
  EXPECT_EQ(*events_[0].second.FindString("kind"), "selection");
  EXPECT_FALSE(events_[0].second.FindDict("data")->contains("secret"));
  Post("selection", R"({"text":"bad rectangle"})");
  EXPECT_TRUE(events_.back().second.Find("data")->is_none());
  Post("scroll", R"({"state":"sideways"})");
  EXPECT_EQ(events_.size(), 2u);
  Post("scroll", R"({"state":"down","extra":"ignored"})");
  EXPECT_EQ(*events_.back().second.FindDict("data")->FindString("state"), "down");
  Post("unknown", R"({"arbitrary":"data"})");
  EXPECT_EQ(events_.size(), 3u);
}

TEST_F(PageMessageEventsTest, SubframesCannotSetTopPageSelectionOrCaptureState) {
  auto* child = Child();
  Post("capture", R"({"state":"save"})", child);
  Post("selection", R"({"text":"no","rect":{"x":0,"y":0,"width":1,"height":1}})", child);
  EXPECT_TRUE(events_.empty());
  Post("capture", R"({"state":"save"})");
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(*events_[0].second.FindString("kind"), "capture");
}

TEST_F(PageMessageEventsTest, LiveNowPlayingStateAndMutedMediaArePreserved) {
  Post("nowPlaying", R"({"title":"Live video","playbackState":"playing","duration":null,"position":18,"live":true,"liveBehind":12,"hasVideo":true,"actions":["play","pause"]})");
  ASSERT_EQ(events_.size(), 1u);
  const auto* state = events_[0].second.FindDict("state");
  ASSERT_TRUE(state);
  EXPECT_TRUE(state->FindBool("live").value());
  EXPECT_EQ(state->FindDouble("liveBehind"), 12);
  EXPECT_TRUE(state->Find("duration")->is_none());
  Post("media", R"({"playing":true})");
  EXPECT_TRUE(PageMessageEvents::MediaState(web_contents()).FindBool("playing").value());
  std::vector<std::pair<std::string, base::DictValue>> replay;
  PageMessageEvents::Replay(web_contents(), base::BindRepeating(
      [](std::vector<std::pair<std::string, base::DictValue>>* events,
         const char* event, base::DictValue payload) {
        events->emplace_back(event, std::move(payload));
      }, &replay));
  ASSERT_EQ(replay.size(), 2u);
  EXPECT_EQ(replay[1].first, "onNowPlaying");
  EXPECT_EQ(*replay[1].second.FindDict("state")->FindString("title"), "Live video");
  EXPECT_EQ(Dispatch("mediaCommand", base::ListValue().Append("seekToLive").Append(base::Value())),
            R"({"value":null})");
  events_.clear();
  NavigateAndCommit(GURL("https://next.test/"));
  EXPECT_TRUE(std::ranges::any_of(events_, [](const auto& event) {
    return event.first == "onNowPlaying" && event.second.Find("state")->is_none();
  }));
}

TEST_F(PageMessageEventsTest, NotificationMessagesRequireNativePermission) {
  Post("notification", R"({"id":"one","title":"Blocked"})");
  EXPECT_TRUE(events_.empty());
  AllowNotifications();
  Post("notification", R"({"id":"one","title":"Allowed","icon":"file:///private/secret","body":"Message"})");
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(events_[0].first, "onNotification");
  const auto id = *events_[0].second.FindString("id");
  EXPECT_NE(id, "one");
  EXPECT_TRUE(events_[0].second.Find("icon")->is_none());
  EXPECT_EQ(*events_[0].second.FindString("origin"), "https://example.test");
  std::vector<std::pair<std::string, base::DictValue>> replay;
  PageMessageEvents::Replay(web_contents(), base::BindRepeating(
      [](std::vector<std::pair<std::string, base::DictValue>>* events,
         const char* event, base::DictValue payload) {
        events->emplace_back(event, std::move(payload));
      }, &replay));
  ASSERT_EQ(replay.size(), 3u);
  EXPECT_EQ(*replay[2].second.FindString("id"), id);
  Post("notificationClose", R"({"id":"one"})");
  ASSERT_EQ(events_.size(), 2u);
  EXPECT_EQ(events_[1].first, "onNotificationClose");
  EXPECT_EQ(*events_[1].second.FindString("id"), id);
}

TEST_F(PageMessageEventsTest, NotificationActionsAreIdempotentAndCloseOnNavigation) {
  AllowNotifications();
  Post("notification", R"({"id":"one","title":"Allowed"})");
  ASSERT_EQ(events_.size(), 1u);
  const auto id = *events_[0].second.FindString("id");
  EXPECT_EQ(Dispatch("notificationAction", base::ListValue().Append(id).Append("click")),
            R"({"value":null})");
  NavigateAndCommit(GURL("https://next.test/"));
  EXPECT_EQ(events_.back().first, "onNotificationClose");
  EXPECT_EQ(Dispatch("notificationAction", base::ListValue().Append(id).Append("close")),
            R"({"value":null})");
}

TEST_F(PageMessageEventsTest, ReplacedNotificationTagsCannotReplayAnOlderNotice) {
  AllowNotifications();
  Post("notification", R"({"id":"one","title":"Old","tag":"updates"})");
  Post("notification", R"({"id":"two","title":"New","tag":"updates"})");
  ASSERT_EQ(events_.size(), 3u);
  EXPECT_EQ(events_[1].first, "onNotificationClose");
  EXPECT_EQ(*events_[2].second.FindString("title"), "New");
  std::vector<base::DictValue> notifications;
  PageMessageEvents::Replay(web_contents(), base::BindRepeating(
      [](std::vector<base::DictValue>* notifications,
         const char* event, base::DictValue payload) {
        if (std::string_view(event) == "onNotification")
          notifications->push_back(std::move(payload));
      }, &notifications));
  ASSERT_EQ(notifications.size(), 1u);
  EXPECT_EQ(*notifications[0].FindString("title"), "New");
}

TEST_F(PageMessageEventsTest, EngineEventsNeverLeakRawMessagesToGenericBroadcasts) {
  EXPECT_FALSE(PageMessageEvents::HandleEngineEvent("downloads.changed", {}));
  EXPECT_TRUE(PageMessageEvents::HandleEngineEvent("tabs.pageMessage", {}));
  EXPECT_TRUE(PageMessageEvents::HandleEngineEvent(
      "tabs.pageMessage", base::DictValue().Set("browserId", 999999)
          .Set("profile", "/another/profile").Set("frame", "bad")
          .Set("kind", "selection").Set("json", "{}")));
  EXPECT_TRUE(events_.empty());
}
}  // namespace
}  // namespace bay
