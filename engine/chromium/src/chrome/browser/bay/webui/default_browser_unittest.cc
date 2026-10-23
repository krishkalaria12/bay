// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/default_browser.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/json/json_reader.h"
#include "base/test/bind.h"
#include "base/test/test_future.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "chrome/test/base/testing_profile.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
using State = shell_integration::DefaultWebClientState;
using Done = shell_integration::DefaultWebClientWorkerCallback;

class DefaultBrowserTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    service_ = std::make_unique<DefaultBrowser>(
        HostContext::ForCoordinator(*profile()),
        base::BindLambdaForTesting([this](bool set_as_default, Done done) {
          operations_.push_back(set_as_default);
          if (synchronous_)
            std::move(done).Run(shell_integration::IS_DEFAULT);
          else
            completions_.push_back(std::move(done));
        }));
  }
  void TearDown() override {
    service_.reset();
    completions_.clear();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  void ExpectClosed(const std::string& response) {
    auto value = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(value);
    const auto* code = value->FindStringByDottedPath("error.code");
    ASSERT_TRUE(code);
    EXPECT_EQ(*code, "host_closed");
  }
  std::unique_ptr<DefaultBrowser> service_;
  std::vector<bool> operations_;
  std::vector<Done> completions_;
  bool synchronous_ = false;
};

TEST_F(DefaultBrowserTest, CatalogIsBoundedAndUnhandledCallbackIsUntouched) {
  const auto methods = DefaultBrowser::SupportedMethods();
  EXPECT_EQ(methods.size(), 2u);
  EXPECT_TRUE(methods.contains("BaySystem.isDefaultBrowser"));
  EXPECT_TRUE(methods.contains("BaySystem.setAsDefaultBrowser"));
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  EXPECT_FALSE(service_->Dispatch("BayApp", "isDefaultBrowser", {}, callback));
  EXPECT_FALSE(
      service_->Dispatch("BaySystem", "setLaunchAtLogin", {}, callback));
  EXPECT_TRUE(callback);
  EXPECT_FALSE(result.IsReady());
  EXPECT_TRUE(operations_.empty());
}

TEST_F(DefaultBrowserTest, BothMethodsReturnTrueOnlyForIsDefault) {
  for (const char* method : {"isDefaultBrowser", "setAsDefaultBrowser"}) {
    for (State state :
         {shell_integration::IS_DEFAULT, shell_integration::NOT_DEFAULT,
          shell_integration::UNKNOWN_DEFAULT,
          shell_integration::OTHER_MODE_IS_DEFAULT}) {
      base::test::TestFuture<const std::string&> result;
      auto callback = result.GetCallback();
      EXPECT_TRUE(service_->Dispatch("BaySystem", method, {}, callback));
      EXPECT_FALSE(callback);
      EXPECT_FALSE(result.IsReady());
      EXPECT_EQ(operations_.back(),
                std::string(method) == "setAsDefaultBrowser");
      std::move(completions_.back()).Run(state);
      EXPECT_EQ(result.Get(), state == shell_integration::IS_DEFAULT
                                  ? R"({"value":true})"
                                  : R"({"value":false})");
    }
  }
}

TEST_F(DefaultBrowserTest, ConcurrentRequestsCompleteIndependentlyOutOfOrder) {
  base::test::TestFuture<const std::string&> check;
  base::test::TestFuture<const std::string&> set;
  auto check_callback = check.GetCallback();
  auto set_callback = set.GetCallback();
  service_->Dispatch("BaySystem", "isDefaultBrowser", {}, check_callback);
  service_->Dispatch("BaySystem", "setAsDefaultBrowser", {}, set_callback);
  ASSERT_EQ(completions_.size(), 2u);
  std::move(completions_[1]).Run(shell_integration::IS_DEFAULT);
  EXPECT_EQ(set.Get(), R"({"value":true})");
  EXPECT_FALSE(check.IsReady());
  std::move(completions_[0]).Run(shell_integration::UNKNOWN_DEFAULT);
  EXPECT_EQ(check.Get(), R"({"value":false})");
}

TEST_F(DefaultBrowserTest,
       TeardownSettlesAllRequestsAndIgnoresLateCompletions) {
  int calls = 0;
  for (const char* method : {"isDefaultBrowser", "setAsDefaultBrowser"}) {
    DefaultBrowser::Response callback =
        base::BindLambdaForTesting([this, &calls](const std::string& response) {
          ++calls;
          ExpectClosed(response);
        });
    service_->Dispatch("BaySystem", method, {}, callback);
  }
  EXPECT_EQ(calls, 0);
  service_.reset();
  EXPECT_EQ(calls, 2);
  for (auto& done : completions_)
    std::move(done).Run(shell_integration::IS_DEFAULT);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls, 2);
}

TEST_F(DefaultBrowserTest, SynchronousCompletionCanDestroyOwner) {
  synchronous_ = true;
  int calls = 0;
  DefaultBrowser::Response callback =
      base::BindLambdaForTesting([this, &calls](const std::string& response) {
        ++calls;
        EXPECT_EQ(response, R"({"value":true})");
        service_.reset();
      });
  EXPECT_TRUE(
      service_->Dispatch("BaySystem", "isDefaultBrowser", {}, callback));
  EXPECT_FALSE(service_);
  EXPECT_EQ(calls, 1);
}

TEST_F(DefaultBrowserTest,
       ResponseCanReenterBeforeClosingOtherPendingRequests) {
  int calls = 0;
  DefaultBrowser::Response callback =
      base::BindLambdaForTesting([this, &calls](const std::string& response) {
        ++calls;
        EXPECT_EQ(response, R"({"value":true})");
        DefaultBrowser::Response again = base::BindLambdaForTesting(
            [this, &calls](const std::string& closed) {
              ++calls;
              ExpectClosed(closed);
            });
        service_->Dispatch("BaySystem", "setAsDefaultBrowser", {}, again);
        service_.reset();
      });
  service_->Dispatch("BaySystem", "isDefaultBrowser", {}, callback);
  // Move out before invoking: reentrant Dispatch grows completions_.
  auto done = std::move(completions_[0]);
  std::move(done).Run(shell_integration::IS_DEFAULT);
  EXPECT_EQ(calls, 2);
  ASSERT_EQ(completions_.size(), 2u);
  std::move(completions_[1]).Run(shell_integration::IS_DEFAULT);
  EXPECT_EQ(calls, 2);
}
}  // namespace
}  // namespace bay
