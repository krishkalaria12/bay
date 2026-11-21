// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/dev_window.h"

#include <limits>
#include <memory>
#include <string>

#include "base/json/json_reader.h"
#include "base/scoped_environment_variable_override.h"
#include "base/test/bind.h"
#include "chrome/browser/bay/webui/dev_window_input.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/test/base/browser_with_test_window_test.h"
#include "chrome/test/base/test_browser_window.h"
#include "chrome/test/base/testing_profile.h"
#include "components/sessions/content/session_tab_helper.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
class TrackingWindow : public TestBrowserWindow {
 public:
  void Show() override {
    visible = true;
    action = "show";
  }
  void Hide() override {
    visible = false;
    action = "hide";
  }
  void Activate() override {
    active = true;
    action = "activate";
  }
  void Deactivate() override {
    active = false;
    action = "deactivate";
  }
  void Minimize() override {
    minimized = true;
    action = "minimize";
  }
  void Maximize() override {
    maximized = true;
    action = "maximize";
  }
  void Restore() override {
    minimized = maximized = false;
    action = "restore";
  }
  void Close() override { action = "close"; }
  bool IsVisible() const override { return visible; }
  bool IsActive() const override { return active; }
  bool IsMinimized() const override { return minimized; }
  bool IsMaximized() const override { return maximized; }
  bool IsFullscreen() const override { return fullscreen; }
  gfx::Rect GetBounds() const override { return {20, 30, 900, 650}; }
  bool visible = true;
  bool active = true;
  bool minimized = false;
  bool maximized = false;
  bool fullscreen = false;
  std::string action;
};
}  // namespace

class DevWindowTest : public BrowserWithTestWindowTest {
 protected:
  std::optional<std::string> GetDefaultProfileName() override {
    return "Default";
  }
  std::unique_ptr<BrowserWindow> CreateBrowserWindow() override {
    auto window = std::make_unique<TrackingWindow>();
    current_window_ = window.get();
    return window;
  }
  void SetUp() override {
    BrowserWithTestWindowTest::SetUp();
    owner_ = current_window_;
    ASSERT_TRUE(
        WindowRegistry::Get()
            .Open(
                HostContext::ForWindow(*browser()), "dev-window-test",
                base::DictValue().Set("profile", "Default").Set("focus", false))
            .ok);
  }
  base::DictValue Invoke(const std::string& method,
                         base::ListValue args,
                         BrowserWindowInterface* owner = nullptr) {
    std::string json;
    DevWindow::Response response = base::BindLambdaForTesting(
        [&](const std::string& value) { json = value; });
    EXPECT_TRUE(
        DevWindow::Dispatch(owner ? HostContext::ForWindow(*owner)
                                  : HostContext::ForCoordinator(*profile()),
                            method, args, response));
    return base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC)
        .value_or(base::DictValue());
  }
  base::DictValue Act(const std::string& action) {
    return Invoke("devWindow", base::ListValue()
                                   .Append(browser()->GetSessionID().id())
                                   .Append(action));
  }
  void ExpectError(const base::DictValue& reply, const char* code) {
    const auto* actual = reply.FindStringByDottedPath("error.code");
    ASSERT_TRUE(actual);
    EXPECT_EQ(*actual, code);
  }
  TrackingWindow* owner_ = nullptr;

 private:
  TrackingWindow* current_window_ = nullptr;
};

TEST_F(DevWindowTest, EnumeratesOwnedWindowsAndResolvesTabNumbers) {
  AddTab(browser(), GURL("https://example.test/"));
  const int browser_id =
      sessions::SessionTabHelper::IdForTab(
          browser()->tab_strip_model()->GetActiveWebContents())
          .id();
  auto reply = Invoke("chromeWindows", base::ListValue());
  const auto* windows = reply.FindList("value");
  ASSERT_TRUE(windows);
  ASSERT_EQ(windows->size(), 1u);
  EXPECT_EQ((*windows)[0].GetDict().FindInt("window"),
            browser()->GetSessionID().id());
  EXPECT_EQ(*(*windows)[0].GetDict().FindString("profile"), "");
  EXPECT_EQ(Invoke("devWindowNumber", base::ListValue().Append(browser_id))
                .FindInt("value"),
            browser()->GetSessionID().id());
  EXPECT_EQ(Invoke("devWindowNumber",
                   base::ListValue().Append(std::numeric_limits<int>::max()))
                .FindInt("value"),
            0);
}

TEST_F(DevWindowTest, ReportsRealNativeStateWithoutRequiringScratchData) {
  base::ScopedEnvironmentVariableOverride no_data_dir("BAY_DATA_DIR");
  owner_->fullscreen = true;
  auto reply = Act("fullScreen");
  const auto* value = reply.FindString("value");
  ASSERT_TRUE(value);
  auto state = base::JSONReader::ReadDict(*value, base::JSON_PARSE_RFC);
  ASSERT_TRUE(state);
  EXPECT_EQ(state->FindBool("fullScreen"), true);
  EXPECT_EQ(state->FindBool("visible"), true);
  EXPECT_EQ(state->FindBool("active"), true);
  EXPECT_EQ(*state->FindList("bounds"),
            base::ListValue().Append(20).Append(30).Append(900).Append(650));
  ExpectError(Act("hide"), "permission_denied");
  EXPECT_TRUE(owner_->action.empty());
}

TEST_F(DevWindowTest, AppliesPortableNativeActionsOnlyInIsolatedInstances) {
  base::ScopedEnvironmentVariableOverride data_dir("BAY_DATA_DIR",
                                                   "/tmp/bay-dev-test");
  for (const char* action : {"hide", "show", "deactivate", "activate",
                             "minimize", "maximize", "restore"}) {
    EXPECT_TRUE(Act(action).contains("value"));
    EXPECT_EQ(owner_->action, action);
  }
  EXPECT_EQ(*Act("ns:out").FindString("value"), "visible=0");
  EXPECT_EQ(*Act("ns:in").FindString("value"), "visible=1");
  ExpectError(Act("fakeFullScreen:1"), "unsupported_action");
  EXPECT_EQ(*Act("close-button").FindString("value"), "clicked");
  EXPECT_NE(owner_->action, "close");
  task_environment()->RunUntilIdle();
  EXPECT_EQ(owner_->action, "close");
}

TEST_F(DevWindowTest, RejectsMalformedCallsAndWindowsOutsideTheCallingFrame) {
  auto other = CreateBrowser(profile(), Browser::TYPE_NORMAL, false);
  ASSERT_TRUE(
      WindowRegistry::Get()
          .Open(HostContext::ForWindow(*other), "other-dev-window",
                base::DictValue().Set("profile", "Default").Set("focus", false))
          .ok);
  auto scoped = Invoke("chromeWindows", base::ListValue(), browser());
  ASSERT_EQ(scoped.FindList("value")->size(), 1u);
  ExpectError(
      Invoke(
          "devWindow",
          base::ListValue().Append(other->GetSessionID().id()).Append("winfo"),
          browser()),
      "no_window");
  ExpectError(Invoke("chromeWindows", base::ListValue().Append(1)),
              "invalid_args");
  ExpectError(Invoke("devWindowNumber", base::ListValue().Append(1.5)),
              "invalid_args");
  ExpectError(Invoke("devWindow", base::ListValue().Append(0).Append("winfo")),
              "invalid_args");
  ExpectError(
      Invoke(
          "devWindow",
          base::ListValue().Append(browser()->GetSessionID().id()).Append(1)),
      "invalid_args");
  ExpectError(Invoke("devWindow", base::ListValue()
                                      .Append(std::numeric_limits<int>::max())
                                      .Append("winfo")),
              "no_window");
  other.reset();
}
// The scripts' input vocabulary is macOS's, so one script drives every host.
TEST(DevWindowInputTest, MouseActionsKeepMacSemantics) {
  const auto click = ParseDevMouseAction("click:85,133");
  ASSERT_TRUE(click);
  ASSERT_EQ(click->size(), 3u);
  EXPECT_EQ((*click)[0].type, ui::EventType::kMouseMoved);
  EXPECT_EQ((*click)[1].type, ui::EventType::kMousePressed);
  EXPECT_EQ((*click)[1].changed_flags, ui::EF_LEFT_MOUSE_BUTTON);
  EXPECT_EQ((*click)[1].point, gfx::PointF(85, 133));
  EXPECT_EQ((*click)[2].type, ui::EventType::kMouseReleased);
  EXPECT_EQ((*ParseDevKeyAction("keys:262144::121"))[0].key, ui::VKEY_NEXT);
  EXPECT_EQ((*ParseDevKeyAction("keys:0::109"))[0].key, ui::VKEY_F10);
  EXPECT_EQ((*ParseDevMouseAction("click:1,2,right"))[2].flags,
            ui::EF_RIGHT_MOUSE_BUTTON);
  const auto twice = ParseDevMouseAction("mouse:down:10.5,4,2");
  ASSERT_TRUE(twice);
  ASSERT_EQ(twice->size(), 1u);
  EXPECT_EQ((*twice)[0].click_count, 2);
  EXPECT_EQ((*twice)[0].point, gfx::PointF(10.5, 4));
  // A tear-off drags out of the window, above its top edge.
  const auto drag = ParseDevMouseAction("drag:10,21;10,-40;90,-90");
  ASSERT_TRUE(drag);
  ASSERT_EQ(drag->size(), 2u + 24u + 1u);
  EXPECT_EQ((*drag)[13].type, ui::EventType::kMouseDragged);
  EXPECT_EQ((*drag)[13].point, gfx::PointF(10, -40));
  EXPECT_EQ(drag->back().type, ui::EventType::kMouseReleased);
  EXPECT_EQ(drag->back().point, gfx::PointF(90, -90));
  EXPECT_LT((*drag)[13].delay, drag->back().delay);
  for (const char* bad :
       {"click:", "click:1", "click:1,2,left", "mouse:hover:1,2",
        "mouse:down:1,2,9", "drag:1,2", "drag:1,2;x,y", "click:1e9,0"}) {
    EXPECT_FALSE(ParseDevMouseAction(bad)) << bad;
  }
}

TEST(DevWindowInputTest, KeyActionsUseThePrimaryModifierAndKeyCodes) {
  const auto undo = ParseDevKeyAction("keys:1048576:z:6");
  ASSERT_TRUE(undo);
  ASSERT_EQ(undo->size(), 2u);
  EXPECT_EQ((*undo)[0].type, ui::EventType::kKeyPressed);
  EXPECT_EQ((*undo)[0].key, ui::VKEY_Z);
  EXPECT_EQ((*undo)[0].flags, ui::EF_CONTROL_DOWN);
  EXPECT_EQ((*undo)[1].type, ui::EventType::kKeyReleased);
  EXPECT_EQ((*ParseDevKeyAction("keys:131072::36"))[0].key, ui::VKEY_RETURN);
  const auto typed = ParseDevKeyAction("type:aB");
  ASSERT_TRUE(typed);
  ASSERT_EQ(typed->size(), 4u);
  EXPECT_EQ((*typed)[0].flags, 0);
  EXPECT_EQ((*typed)[2].key, ui::VKEY_B);
  EXPECT_EQ((*typed)[2].flags, ui::EF_SHIFT_DOWN);
  for (const char* bad : {"keys:", "keys:x:z", "keys:0:zz", "keys:0:", "type:"})
    EXPECT_FALSE(ParseDevKeyAction(bad)) << bad;
}

TEST_F(DevWindowTest, InputActionsNeedAnIsolatedInstanceAndAWindowSurface) {
  {
    base::ScopedEnvironmentVariableOverride no_data_dir("BAY_DATA_DIR");
    ExpectError(Act("click:1,2"), "permission_denied");
    ExpectError(Act("keys:0:a"), "permission_denied");
  }
  base::ScopedEnvironmentVariableOverride data_dir("BAY_DATA_DIR",
                                                   "/tmp/bay-dev-test");
  ExpectError(Act("click:1"), "invalid_args");
  // A test window has no Aura surface: nothing to deliver input to.
  ExpectError(Act("click:1,2"), "no_widget");
  ExpectError(Act("type:a"), "no_widget");
  EXPECT_EQ(*Act("fakeActiveClicks").FindString("value"), "1");
  ExpectError(Act("hit:1"), "invalid_args");
  ExpectError(Act("windowDrags"), "unsupported_action");
}

TEST(DevHarnessTest, HooksNeedAnIsolatedInstance) {
  {
    base::ScopedEnvironmentVariableOverride no_data_dir("BAY_DATA_DIR");
    EXPECT_FALSE(DevHarnessAllowed());
  }
  base::ScopedEnvironmentVariableOverride data_dir("BAY_DATA_DIR",
                                                   "/tmp/bay-dev-test");
  EXPECT_TRUE(DevHarnessAllowed());
}
}  // namespace bay
