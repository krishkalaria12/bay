// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/app_services_linux.h"

#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/dcheck_is_on.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/test/bind.h"
#include "base/test/test_future.h"
#include "chrome/browser/ui/browser_window/test/mock_browser_window_interface.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "chrome/test/base/testing_profile.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/browser_thread.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace bay {
namespace {
// The pinned mock predates this BrowserWindowInterface pure virtual method.
class AppWindow : public MockBrowserWindowInterface {
 public:
  bool IsNormalBrowser() const override { return true; }
};

class AppServicesLinuxTest
    : public ChromeRenderViewHostTestHarness,
      public testing::WithParamInterface<HostContext::Role> {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    ON_CALL(window_, GetProfile()).WillByDefault(testing::Return(profile()));
    ON_CALL(window_, GetWeakPtr())
        .WillByDefault(testing::Return(window_weak_factory_.GetWeakPtr()));
    for (const char* key :
         {"BAY_BACKGROUND", "BAY_CALENDAR_FIXTURE", "BAY_LIVE_MOCK",
          "BAY_ONBOARDING", "BAY_WHATS_NEW", "BAY_TELEMETRY_DEV_SEND",
          "BAY_PERF_PROBE", "BAY_DATA_DIR"})
      environment_[key] = std::string("fixture:") + key;
    environment_["SECRET"] = "must not be read";
    app_ = std::make_unique<AppServicesLinux>(Context(), "en-IN", Operations());
  }
  void TearDown() override {
    app_.reset();
    task_environment()->RunUntilIdle();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  HostContext Context() {
    return GetParam() == HostContext::Role::kWindow
               ? HostContext::ForWindow(window_)
               : HostContext::ForCoordinator(*profile());
  }
  AppServicesLinux::Operations Operations() {
    AppServicesLinux::Operations operations;
    operations.collect_system_info = base::BindLambdaForTesting(
        [this](AppServicesLinux::SystemInfoReply reply) {
          EXPECT_TRUE(
              content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
          ++collections_;
          system_reply_ = std::move(reply);
        });
    operations.read_environment = base::BindLambdaForTesting(
        [this](const char* key) -> std::optional<std::string> {
          environment_reads_.emplace_back(key);
          auto it = environment_.find(key);
          return it == environment_.end() ? std::nullopt
                                          : std::make_optional(it->second);
        });
    operations.open_external_url =
        base::BindLambdaForTesting([this](const GURL& url) {
          EXPECT_TRUE(
              content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
          opened_.push_back(url);
          if (on_open_)
            on_open_.Run();
        });
    return operations;
  }
  base::DictValue CollectedInfo() {
    return base::DictValue()
        .Set("osVersion", "6.8.0-fixture")
        .Set("osBuild", "6.8.0-fixture")
        .Set("arch", "fixture-process-arch")
        .Set("model", "fixture model")
        .Set("memoryGB", 16.0);
  }
  void FinishCollection() {
    ASSERT_TRUE(system_reply_);
    std::move(system_reply_).Run(CollectedInfo());
  }
  void Prepare() {
    base::test::TestFuture<void> ready;
    app_->Prepare(ready.GetCallback());
    EXPECT_FALSE(ready.IsReady());
    FinishCollection();
    EXPECT_TRUE(ready.IsReady());
    EXPECT_TRUE(app_->ready());
  }
  std::string Invoke(const char* method, base::ListValue args = {}) {
    base::test::TestFuture<const std::string&> result;
    auto callback = result.GetCallback();
    EXPECT_TRUE(app_->Dispatch("BayApp", method, args, callback));
    EXPECT_FALSE(callback);
    EXPECT_TRUE(result.IsReady());
    return result.Get();
  }
  base::DictValue Result(const char* method, base::ListValue args = {}) {
    auto result = base::JSONReader::ReadDict(Invoke(method, std::move(args)),
                                             base::JSON_PARSE_RFC);
    EXPECT_TRUE(result);
    return result ? std::move(*result) : base::DictValue();
  }
  void ExpectError(const std::string& response, const char* code) {
    auto result = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(result);
    const auto* actual = result->FindStringByDottedPath("error.code");
    ASSERT_TRUE(actual);
    EXPECT_EQ(*actual, code);
  }

  testing::NiceMock<AppWindow> window_;
  base::WeakPtrFactory<BrowserWindowInterface> window_weak_factory_{&window_};
  std::unique_ptr<AppServicesLinux> app_;
  AppServicesLinux::SystemInfoReply system_reply_;
  std::map<std::string, std::string> environment_;
  std::vector<std::string> environment_reads_;
  std::vector<GURL> opened_;
  base::RepeatingClosure on_open_;
  int collections_ = 0;
};

TEST_P(AppServicesLinuxTest,
       AdvertisesOnlyFourMethodsAndPreservesUnhandledCalls) {
  auto methods = AppServicesLinux::SupportedMethods();
  EXPECT_EQ(methods.size(), 4u);
  for (const char* method : {"BayApp.systemInfo", "BayApp.launchEnvironment",
                             "BayApp.openExternalURL", "BayApp.updaterState"})
    EXPECT_TRUE(methods.contains(method));
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  for (const char* method :
       {"environment", "checkForUpdates", "installPendingUpdate",
        "setAutomaticUpdateChecks", "setAutomaticUpdateDownloads"}) {
    EXPECT_FALSE(methods.contains(std::string("BayApp.") + method));
    EXPECT_FALSE(app_->Dispatch("BayApp", method, {}, callback));
  }
  EXPECT_FALSE(app_->Dispatch("BayShell", "systemInfo", {}, callback));
  EXPECT_TRUE(callback);
  EXPECT_FALSE(result.IsReady());
}

TEST_P(AppServicesLinuxTest, ReadinessWaitsForCompleteSnapshotAndCollectsOnce) {
  EXPECT_FALSE(app_->ready());
  EXPECT_TRUE(app_->snapshots().empty());
  for (const char* method :
       {"systemInfo", "launchEnvironment", "updaterState", "openExternalURL"})
    ExpectError(Invoke(method), "initialization_failed");
  base::test::TestFuture<void> first, second, again;
  app_->Prepare(first.GetCallback());
  app_->Prepare(second.GetCallback());
  EXPECT_EQ(collections_, 1);
  EXPECT_FALSE(app_->ready());
  EXPECT_TRUE(app_->snapshots().empty());
  EXPECT_FALSE(first.IsReady());
  EXPECT_FALSE(second.IsReady());
  FinishCollection();
  EXPECT_TRUE(first.IsReady());
  EXPECT_TRUE(second.IsReady());
  EXPECT_TRUE(app_->ready());
  app_->Prepare(again.GetCallback());
  EXPECT_TRUE(again.IsReady());
  EXPECT_EQ(collections_, 1);
  EXPECT_TRUE(opened_.empty());
}

TEST_P(AppServicesLinuxTest, SnapshotMatchesFacadeAndReturnsIndependentClones) {
  Prepare();
  auto snapshots = app_->snapshots();
  EXPECT_FALSE(snapshots.contains("BayApp"));
  const auto* system = snapshots.FindDict("systemInfo");
  ASSERT_TRUE(system);
  auto expected = CollectedInfo();
  expected.Set("appName", "Bay");
  expected.Set("appVersion", version_info::GetVersionNumber());
  expected.Set("appBuild", version_info::GetLastChange());
  expected.Set("bundleId", "Bay.Browser");
#if DCHECK_IS_ON()
  expected.Set("configuration", "Debug");
#else
  expected.Set("configuration", "Release");
#endif
  expected.Set("locale", "en-IN");
  expected.Set("updates", false);
  EXPECT_EQ(*system, expected);
  const auto result = Result("systemInfo");
  ASSERT_TRUE(result.FindDict("value"));
  EXPECT_EQ(*result.FindDict("value"), expected);
  snapshots.FindDict("systemInfo")->Set("appName", "changed clone");
  EXPECT_EQ(*app_->snapshots().FindDict("systemInfo"), expected);
}

TEST_P(AppServicesLinuxTest, UpdaterIsExplicitlyManagedByThePackageManager) {
  Prepare();
  const auto expected = base::DictValue()
                            .Set("available", false)
                            .Set("managedBy", "packageManager");
  auto result = Result("updaterState");
  ASSERT_TRUE(result.FindDict("value"));
  EXPECT_EQ(*result.FindDict("value"), expected);
  auto snapshots = app_->snapshots();
  ASSERT_TRUE(snapshots.FindDict("updaterState"));
  EXPECT_EQ(*snapshots.FindDict("updaterState"), expected);
}

TEST_P(AppServicesLinuxTest,
       EnvironmentIsDebugAllowlistedAndNeverReadAtDispatch) {
  Prepare();
  auto snapshots = app_->snapshots();
  const auto* environment = snapshots.FindDict("environment");
  ASSERT_TRUE(environment);
#if DCHECK_IS_ON()
  const std::vector<std::string> allowed = {
      "BAY_BACKGROUND", "BAY_CALENDAR_FIXTURE", "BAY_LIVE_MOCK",
      "BAY_ONBOARDING", "BAY_WHATS_NEW",        "BAY_TELEMETRY_DEV_SEND",
      "BAY_PERF_PROBE", "BAY_DATA_DIR"};
  EXPECT_EQ(environment_reads_, allowed);
  EXPECT_EQ(environment->size(), allowed.size());
  for (const auto& key : allowed) {
    ASSERT_TRUE(environment->FindString(key));
    EXPECT_EQ(*environment->FindString(key), "fixture:" + key);
  }
#else
  EXPECT_TRUE(environment_reads_.empty());
  EXPECT_TRUE(environment->empty());
#endif
  const auto reads = environment_reads_;
  environment_["BAY_BACKGROUND"] = "changed after prepare";
  for (const auto& [key, value] : environment_) {
    auto result = Result("launchEnvironment", base::ListValue().Append(key));
    const auto* actual = result.Find("value");
    ASSERT_TRUE(actual);
    const auto* captured = environment->Find(key);
    if (captured)
      EXPECT_EQ(*actual, *captured);
    else
      EXPECT_TRUE(actual->is_none());
  }
  for (const char* key : {"", "PATH", "HOME", "BAY_UNLISTED", "unknown"})
    EXPECT_EQ(Invoke("launchEnvironment", base::ListValue().Append(key)),
              R"({"value":null})");
  EXPECT_EQ(environment_reads_, reads);
}

TEST_P(AppServicesLinuxTest, MissingAndInvalidEnvironmentValuesAreOmitted) {
  environment_.erase("BAY_BACKGROUND");
  environment_["BAY_DATA_DIR"] = std::string("\xff", 1);
  environment_["BAY_ONBOARDING"] = "";
  Prepare();
  auto snapshots = app_->snapshots();
  const auto* environment = snapshots.FindDict("environment");
  ASSERT_TRUE(environment);
  EXPECT_FALSE(environment->contains("BAY_BACKGROUND"));
  EXPECT_FALSE(environment->contains("BAY_DATA_DIR"));
  EXPECT_EQ(
      Invoke("launchEnvironment", base::ListValue().Append("BAY_BACKGROUND")),
      R"({"value":null})");
#if DCHECK_IS_ON()
  EXPECT_EQ(
      Invoke("launchEnvironment", base::ListValue().Append("BAY_ONBOARDING")),
      R"({"value":""})");
#else
  EXPECT_EQ(
      Invoke("launchEnvironment", base::ListValue().Append("BAY_ONBOARDING")),
      R"({"value":null})");
#endif
}

TEST_P(AppServicesLinuxTest, RejectsInvalidTypesNulUtf8AndArityWithoutEffects) {
  Prepare();
  for (const char* method : {"launchEnvironment", "openExternalURL"}) {
    for (const char* json : {"[]", "[null]", "[false]", "[1]", "[{}]", "[[]]",
                             "[\"https://example.test\", 1]"}) {
      auto args = base::JSONReader::ReadList(json, base::JSON_PARSE_RFC);
      ASSERT_TRUE(args);
      ExpectError(Invoke(method, std::move(*args)), "invalid_args");
    }
    for (const auto& text : {std::string("https://example.test/\0evil", 26),
                             std::string("https://example.test/\xff", 22)})
      ExpectError(Invoke(method, base::ListValue().Append(text)),
                  "invalid_args");
  }
  for (const char* method : {"systemInfo", "updaterState"})
    ExpectError(Invoke(method, base::ListValue().Append(1)), "invalid_args");
  EXPECT_TRUE(opened_.empty());
}

TEST_P(AppServicesLinuxTest, AllowsOnlyHttpHttpsAndMailtoSubmissions) {
  Prepare();
  for (const char* url :
       {"https://example.test/a?q=b#c", "http://example.test/",
        "mailto:user@example.test?subject=fixture", "HTTPS://EXAMPLE.TEST/"}) {
    EXPECT_EQ(Invoke("openExternalURL", base::ListValue().Append(url)),
              R"({"value":true})");
    ASSERT_FALSE(opened_.empty());
    EXPECT_EQ(opened_.back(), GURL(url));
  }
  EXPECT_EQ(opened_.size(), 4u);
  for (const char* url :
       {"", "not a URL", "https://", "http://[invalid", "file:///tmp/fixture",
        "ftp://example.test/", "javascript:alert(1)", "data:text/plain,fixture",
        "bay://settings", "custom:fixture"})
    ExpectError(Invoke("openExternalURL", base::ListValue().Append(url)),
                "invalid_args");
  EXPECT_EQ(opened_.size(), 4u);
}

TEST_P(AppServicesLinuxTest, ExpiredProfileRejectsAllMethodsWithoutEffects) {
  auto other = TestingProfile::Builder().Build();
  ON_CALL(window_, GetProfile()).WillByDefault(testing::Return(other.get()));
  auto context = GetParam() == HostContext::Role::kWindow
                     ? HostContext::ForWindow(window_)
                     : HostContext::ForCoordinator(*other);
  app_ = std::make_unique<AppServicesLinux>(context, "en-IN", Operations());
  Prepare();
  other.reset();
  for (const char* method :
       {"systemInfo", "launchEnvironment", "updaterState", "openExternalURL"})
    ExpectError(Invoke(method), "profile_unavailable");
  EXPECT_TRUE(opened_.empty());
}

TEST_P(AppServicesLinuxTest, TeardownCancelsPendingPrepareAndIgnoresLateReply) {
  int calls = 0;
  app_->Prepare(base::BindLambdaForTesting([&] { ++calls; }));
  app_->Prepare(base::BindLambdaForTesting([&] { ++calls; }));
  EXPECT_EQ(collections_, 1);
  app_.reset();
  FinishCollection();
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls, 0);
  EXPECT_TRUE(opened_.empty());
}

TEST_P(AppServicesLinuxTest, ReadyCallbacksMayReenterAndDestroyTheOwner) {
  int calls = 0;
  app_->Prepare(base::BindLambdaForTesting([&] {
    ++calls;
    EXPECT_TRUE(app_->ready());
    EXPECT_TRUE(Result("systemInfo").FindDict("value"));
    app_->Prepare(base::BindLambdaForTesting([&] { ++calls; }));
    app_.reset();
  }));
  app_->Prepare(base::BindLambdaForTesting([&] { ++calls; }));
  FinishCollection();
  EXPECT_FALSE(app_);
  EXPECT_EQ(calls, 3);
}

TEST_P(AppServicesLinuxTest, SynchronousCollectorMayDestroyTheOwnerOnReady) {
  auto operations = Operations();
  operations.collect_system_info = base::BindLambdaForTesting(
      [this](AppServicesLinux::SystemInfoReply reply) {
        ++collections_;
        std::move(reply).Run(CollectedInfo());
      });
  app_ = std::make_unique<AppServicesLinux>(Context(), "en-IN",
                                            std::move(operations));
  int calls = 0;
  app_->Prepare(base::BindLambdaForTesting([&] {
    ++calls;
    app_.reset();
  }));
  EXPECT_FALSE(app_);
  EXPECT_EQ(calls, 1);
  EXPECT_EQ(collections_, 1);
}

TEST_P(AppServicesLinuxTest, OpenerMayReenterAndDestroyOwnerBeforeResponse) {
  Prepare();
  int calls = 0;
  on_open_ = base::BindLambdaForTesting([&] {
    EXPECT_TRUE(Result("updaterState").FindDict("value"));
    app_.reset();
  });
  AppServicesLinux::Response callback =
      base::BindLambdaForTesting([&](const std::string& result) {
        ++calls;
        EXPECT_FALSE(app_);
        EXPECT_EQ(result, R"({"value":true})");
      });
  EXPECT_TRUE(app_->Dispatch("BayApp", "openExternalURL",
                             base::ListValue().Append("https://example.test/"),
                             callback));
  EXPECT_FALSE(callback);
  EXPECT_EQ(calls, 1);
  EXPECT_EQ(opened_.size(), 1u);
}

TEST_P(AppServicesLinuxTest, ResponseMayDestroyOwnerExactlyOnce) {
  Prepare();
  int calls = 0;
  AppServicesLinux::Response callback =
      base::BindLambdaForTesting([&](const std::string& result) {
        ++calls;
        EXPECT_EQ(result, R"({"value":true})");
        app_.reset();
      });
  EXPECT_TRUE(app_->Dispatch(
      "BayApp", "openExternalURL",
      base::ListValue().Append("mailto:fixture@example.test"), callback));
  EXPECT_FALSE(callback);
  EXPECT_FALSE(app_);
  EXPECT_EQ(calls, 1);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls, 1);
}

INSTANTIATE_TEST_SUITE_P(
    BothRoles,
    AppServicesLinuxTest,
    testing::Values(HostContext::Role::kWindow,
                    HostContext::Role::kCoordinator),
    [](const testing::TestParamInfo<HostContext::Role>& info) {
      return info.param == HostContext::Role::kWindow ? "Window"
                                                      : "Coordinator";
    });
}  // namespace
}  // namespace bay
