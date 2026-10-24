// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_appearance.h"

#include <memory>
#include <string>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/test/bind.h"
#include "base/test/test_future.h"
#include "chrome/browser/themes/theme_helper.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "chrome/test/base/testing_profile.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/native_theme/mock_os_settings_provider.h"
#include "ui/native_theme/native_theme.h"

namespace bay {
namespace {
using Scheme = ThemeService::BrowserColorScheme;
using NativeScheme = ui::NativeTheme::PreferredColorScheme;

class ShellAppearanceTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    os_ = std::make_unique<ui::MockOsSettingsProvider>();
    SetSystemDark(false);
    observer_ = std::make_unique<ShellAppearance>(Context());
  }
  void TearDown() override {
    observer_.reset();
    os_.reset();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  HostContext Context() { return HostContext::ForCoordinator(*profile()); }
  ui::NativeTheme* native() {
    return ui::NativeTheme::GetInstanceForNativeUi();
  }
  void SetSystemDark(bool dark) {
    os_->SetPreferredColorScheme(dark ? NativeScheme::kDark
                                      : NativeScheme::kLight);
  }
  ThemeService* theme() {
    return ThemeServiceFactory::GetForProfile(profile());
  }
  std::string Invoke(const HostContext& context,
                     const std::string& method,
                     base::ListValue args = {}) {
    base::test::TestFuture<const std::string&> result;
    auto callback = result.GetCallback();
    EXPECT_TRUE(
        ShellAppearance::Dispatch(context, "BayShell", method, args, callback));
    EXPECT_TRUE(result.IsReady());
    EXPECT_FALSE(callback);
    return result.Get();
  }
  void Set(const char* mode) {
    EXPECT_EQ(
        Invoke(Context(), "setAppearance", base::ListValue().Append(mode)),
        R"({"value":null})");
  }
  bool Dark(const HostContext& context) {
    auto result = base::JSONReader::ReadDict(
        Invoke(context, "isDarkAppearance"), base::JSON_PARSE_RFC);
    EXPECT_TRUE(result);
    return result && result->FindBool("value").value_or(false);
  }
  void Listen() {
    observer_->SetEventSink(base::BindRepeating(
        [](std::vector<bool>* values, bool dark) { values->push_back(dark); },
        &events_));
  }
  std::unique_ptr<ShellAppearance> observer_;
  std::vector<bool> events_;
  std::unique_ptr<ui::MockOsSettingsProvider> os_;
  ThemeHelper helper_;
};

TEST_F(ShellAppearanceTest,
       AdvertisesOnlyAppearanceAndPreservesUnhandledCallback) {
  auto methods = ShellAppearance::SupportedMethods();
  EXPECT_EQ(methods.size(), 2u);
  EXPECT_TRUE(methods.contains("BayShell.setAppearance"));
  EXPECT_TRUE(methods.contains("BayShell.isDarkAppearance"));
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  EXPECT_FALSE(ShellAppearance::Dispatch(Context(), "BayApp", "setAppearance",
                                         {}, callback));
  EXPECT_FALSE(ShellAppearance::Dispatch(Context(), "BayShell", "copyText", {},
                                         callback));
  EXPECT_TRUE(callback);
  EXPECT_FALSE(result.IsReady());
}

TEST_F(ShellAppearanceTest, QueryUsesSelectedSchemeAndAutoTracksSystem) {
  for (auto system : {NativeScheme::kLight, NativeScheme::kDark,
                      NativeScheme::kNoPreference}) {
    os_->SetPreferredColorScheme(system);
    Set("dark");
    EXPECT_EQ(theme()->GetBrowserColorScheme(), Scheme::kDark);
    EXPECT_TRUE(Dark(Context()));
    Set("light");
    EXPECT_EQ(theme()->GetBrowserColorScheme(), Scheme::kLight);
    EXPECT_FALSE(Dark(Context()));
    Set("auto");
    EXPECT_EQ(theme()->GetBrowserColorScheme(), Scheme::kSystem);
    EXPECT_EQ(Dark(Context()), system == NativeScheme::kDark);
  }
}

TEST_F(ShellAppearanceTest, RejectsInvalidModesWithoutChangingThePreference) {
  Set("dark");
  for (const char* json : {"[]", "[null]", "[true]", "[1]", "[{}]", "[[]]",
                           "[\"\"]", "[\"Dark\"]", "[\"system\"]"}) {
    auto args = base::JSONReader::ReadList(json, base::JSON_PARSE_RFC);
    ASSERT_TRUE(args);
    auto result = base::JSONReader::ReadDict(
        Invoke(Context(), "setAppearance", std::move(*args)),
        base::JSON_PARSE_RFC);
    ASSERT_TRUE(result);
    const auto* code = result->FindStringByDottedPath("error.code");
    ASSERT_TRUE(code);
    EXPECT_EQ(*code, "invalid_args");
    EXPECT_EQ(theme()->GetBrowserColorScheme(), Scheme::kDark);
  }
  // Exact arity belongs to NativeHost, as it did before extraction.
  EXPECT_EQ(Invoke(Context(), "setAppearance",
                   base::ListValue().Append("light").Append(1)),
            R"({"value":null})");
  EXPECT_FALSE(Dark(Context()));
}

TEST_F(ShellAppearanceTest,
       OtrUsesItsOriginalServiceAndDoesNotBorrowOtherProfiles) {
  auto other = TestingProfile::Builder().Build();
  auto* otr = profile()->GetPrimaryOTRProfile(true);
  const auto context = HostContext::ForCoordinator(*otr);
  EXPECT_EQ(ThemeServiceFactory::GetForProfile(otr), theme());
  EXPECT_EQ(Invoke(context, "setAppearance", base::ListValue().Append("dark")),
            R"({"value":null})");
  EXPECT_TRUE(Dark(Context()));
  EXPECT_TRUE(Dark(context));
  EXPECT_FALSE(Dark(HostContext::ForCoordinator(*other)));
  Set("light");
  EXPECT_FALSE(Dark(context));
}

TEST_F(ShellAppearanceTest, ReportsOnlyEffectiveChangesAndFollowsSystemInAuto) {
  Set("auto");
  Listen();
  EXPECT_TRUE(events_.empty());
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false}));
  SetSystemDark(true);
  EXPECT_TRUE(Dark(Context()));
  EXPECT_EQ(events_.size(), 1u);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true}));
  Set("dark");
  SetSystemDark(false);
  theme()->SetBrowserColorScheme(Scheme::kDark);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true}));
  Set("light");
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true, false}));
  SetSystemDark(true);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_.size(), 3u);
  Set("auto");
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true, false, true}));
}

TEST_F(ShellAppearanceTest, SetterNotifiesEvenBeforeThemeServiceIsReady) {
  // A ThemeService without Init remains not-ready and suppresses theme
  // notifications, as when an extension theme pack must finish loading.
  ThemeServiceFactory::GetInstance()->SetTestingFactory(
      profile(),
      base::BindLambdaForTesting([this](content::BrowserContext* context)
                                     -> std::unique_ptr<KeyedService> {
        return std::make_unique<ThemeService>(
            Profile::FromBrowserContext(context), helper_);
      }));
  Listen();
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false}));
  Set("dark");
  EXPECT_TRUE(Dark(Context()));
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true}));
  theme()->SetBrowserColorScheme(Scheme::kLight);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true, false}));
}

TEST_F(ShellAppearanceTest,
       ReconnectGetsCurrentStateAndCancelsOldQueuedDelivery) {
  Listen();
  Set("dark");
  std::vector<bool> replacement;
  observer_->SetEventSink(base::BindRepeating(
      [](std::vector<bool>* values, bool dark) { values->push_back(dark); },
      &replacement));
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(events_.empty());
  EXPECT_EQ(replacement, (std::vector<bool>{true}));
  Set("light");
  observer_->SetEventSink({});
  task_environment()->RunUntilIdle();
  EXPECT_EQ(replacement.size(), 1u);
  Listen();
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false}));
}

TEST_F(ShellAppearanceTest, QueryIsSynchronousAndQueuedEventReadsLatestState) {
  Listen();
  task_environment()->RunUntilIdle();
  events_.clear();
  ShellAppearance::Response callback =
      base::BindLambdaForTesting([this](const std::string& response) {
        EXPECT_EQ(response, R"({"value":null})");
        EXPECT_TRUE(Dark(Context()));
        EXPECT_TRUE(events_.empty());
        Set("light");
      });
  EXPECT_TRUE(ShellAppearance::Dispatch(Context(), "BayShell", "setAppearance",
                                        base::ListValue().Append("dark"),
                                        callback));
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(events_.empty());
  EXPECT_FALSE(Dark(Context()));
}

TEST_F(ShellAppearanceTest, SinkCanReenterChangeAppearanceAndDestroyItsOwner) {
  observer_->SetEventSink(base::BindLambdaForTesting([this](bool dark) {
    events_.push_back(dark);
    if (!dark) {
      Set("dark");
    } else {
      observer_.reset();
    }
  }));
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true}));
  EXPECT_FALSE(observer_);
  SetSystemDark(true);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_.size(), 2u);
}

TEST_F(ShellAppearanceTest, SubscribersStayWithinTheirAssignedOriginalProfile) {
  Set("light");
  Listen();
  auto other = TestingProfile::Builder().Build();
  ShellAppearance unrelated(HostContext::ForCoordinator(*other));
  std::vector<bool> other_events;
  unrelated.SetEventSink(base::BindLambdaForTesting(
      [&other_events](bool dark) { other_events.push_back(dark); }));
  auto* otr = profile()->GetPrimaryOTRProfile(true);
  auto sibling =
      std::make_unique<ShellAppearance>(HostContext::ForCoordinator(*otr));
  std::vector<bool> sibling_events;
  sibling->SetEventSink(base::BindLambdaForTesting(
      [&sibling_events](bool dark) { sibling_events.push_back(dark); }));
  task_environment()->RunUntilIdle();
  Set("dark");
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true}));
  EXPECT_EQ(sibling_events, events_);
  EXPECT_EQ(other_events, (std::vector<bool>{false}));
  profile()->DestroyOffTheRecordProfile(otr);
  Set("light");
  task_environment()->RunUntilIdle();
  EXPECT_EQ(events_, (std::vector<bool>{false, true, false}));
  EXPECT_EQ(sibling_events.size(), 2u);
  sibling.reset();
}

TEST_F(ShellAppearanceTest, DestructionCancelsQueuedEvents) {
  Listen();
  Set("dark");
  observer_.reset();
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(events_.empty());
}

TEST_F(ShellAppearanceTest,
       AssignedProfileDestructionDetachesBeforeServiceShutdown) {
  auto profile = TestingProfile::Builder().Build();
  auto observer =
      std::make_unique<ShellAppearance>(HostContext::ForCoordinator(*profile));
  observer->SetEventSink(base::BindLambdaForTesting(
      [this](bool dark) { events_.push_back(dark); }));
  profile.reset();
  task_environment()->RunUntilIdle();
  SetSystemDark(true);
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(events_.empty());
  observer.reset();
}

TEST_F(ShellAppearanceTest,
       OriginalDestructionNotificationDetachesOtrObserver) {
  auto* otr = profile()->GetPrimaryOTRProfile(true);
  auto observer =
      std::make_unique<ShellAppearance>(HostContext::ForCoordinator(*otr));
  observer->SetEventSink(base::BindLambdaForTesting(
      [this](bool dark) { events_.push_back(dark); }));
  profile()->MaybeSendDestroyedNotification();
  // Cannot reattach during the window before the profile weak pointer expires.
  observer->SetEventSink(base::BindLambdaForTesting(
      [this](bool dark) { events_.push_back(dark); }));
  SetSystemDark(true);
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(events_.empty());
  observer.reset();
}
}  // namespace
}  // namespace bay
