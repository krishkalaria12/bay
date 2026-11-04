// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/keychain.h"

#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/test/bind.h"
#include "base/test/test_future.h"
#include "chrome/browser/ui/browser_window/test/mock_browser_window_interface.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "chrome/test/base/testing_profile.h"
#include "content/public/browser/browser_thread.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
struct FakeSecrets {
  std::map<std::string, std::string> values;
  std::vector<std::string> calls;
  bool unavailable = false;
  std::string Run(const std::string& method,
                  const std::string& account,
                  std::string secret) {
    EXPECT_FALSE(
        content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
    calls.push_back(method + ":" + account);
    if (unavailable)
      return R"({"error":{"code":"credential_error","message":"Keyring locked"}})";
    base::Value value;
    if (method == "get") {
      auto found = values.find(account);
      if (found != values.end())
        value = base::Value(found->second);
    } else {
      if (method == "set")
        values[account] = std::move(secret);
      else
        values.erase(account);
      value = base::Value(true);
    }
    return base::WriteJson(base::DictValue().Set("value", std::move(value)))
        .value();
  }
};

class KeychainWindow : public MockBrowserWindowInterface {
 public:
  bool IsNormalBrowser() const override { return true; }
};

class KeychainTest : public ChromeRenderViewHostTestHarness {
 public:
  KeychainTest()
      : ChromeRenderViewHostTestHarness(
            base::test::TaskEnvironment::ThreadPoolExecutionMode::QUEUED) {}

 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    Reset(HostContext::ForCoordinator(*profile()));
  }
  void TearDown() override {
    keychain_.reset();
    task_environment()->RunUntilIdle();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  void Reset(HostContext context) {
    // The worker holds the fake alive even after the document is destroyed.
    keychain_ = std::make_unique<Keychain>(
        std::move(context),
        base::BindRepeating(
            [](std::shared_ptr<FakeSecrets> fake, const std::string& method,
               const std::string& account, std::string secret) {
              return fake->Run(method, account, std::move(secret));
            },
            fake_));
  }
  std::string Invoke(const char* method, base::ListValue args) {
    base::test::TestFuture<const std::string&> result;
    auto callback = result.GetCallback();
    EXPECT_TRUE(keychain_->Dispatch("BayKeychain", method, args, callback));
    EXPECT_FALSE(callback);
    task_environment()->RunUntilIdle();
    return result.Get();
  }
  void Error(const std::string& response, const char* code) {
    auto parsed = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(parsed);
    const auto* actual = parsed->FindStringByDottedPath("error.code");
    ASSERT_TRUE(actual);
    EXPECT_EQ(*actual, code);
  }
  base::ListValue Account() {
    return base::ListValue().Append("calendar:café");
  }
  std::shared_ptr<FakeSecrets> fake_ = std::make_shared<FakeSecrets>();
  std::unique_ptr<Keychain> keychain_;
};

TEST_F(KeychainTest, CatalogAndUnhandledRequestsLeaveCallbackUntouched) {
  const auto methods = Keychain::SupportedMethods();
  EXPECT_EQ(methods.size(), 3u);
  for (const char* method :
       {"BayKeychain.get", "BayKeychain.set", "BayKeychain.delete"})
    EXPECT_TRUE(methods.contains(method));
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  EXPECT_FALSE(keychain_->Dispatch("BayApp", "get", {}, callback));
  EXPECT_FALSE(keychain_->Dispatch("BayKeychain", "unknown", {}, callback));
  EXPECT_TRUE(callback);
  EXPECT_FALSE(result.IsReady());
}

TEST_F(KeychainTest, InvalidArgumentsNeverReachBackend) {
  for (const char* method : {"get", "delete"}) {
    for (const char* json : {"[]", "[null]", "[true]", "[{}]", "[[]]",
                             R"([""])", R"(["a\u0000b"])", R"(["a",1])"}) {
      auto args = base::JSONReader::ReadList(json, base::JSON_PARSE_RFC);
      ASSERT_TRUE(args);
      Error(Invoke(method, std::move(*args)), "invalid_args");
    }
  }
  for (const char* json : {"[]", R"(["a"])", R"(["a",null])", R"(["a",1])",
                           R"(["a",{}])", R"(["a",[]])", R"(["a","b",1])"}) {
    auto args = base::JSONReader::ReadList(json, base::JSON_PARSE_RFC);
    ASSERT_TRUE(args);
    Error(Invoke("set", std::move(*args)), "invalid_args");
  }
  Error(Invoke("get", base::ListValue().Append(std::string("\xff"))),
        "invalid_args");
  Error(Invoke("set", Account().Append(std::string("\xff"))), "invalid_args");
  EXPECT_TRUE(fake_->calls.empty());
}

TEST_F(KeychainTest, RoundTripOverwriteEmptySecretAndIdempotentDelete) {
  EXPECT_EQ(Invoke("get", Account()), R"({"value":null})");
  for (const std::string secret :
       {std::string("token café"), std::string(), std::string("a\0b", 3)}) {
    EXPECT_EQ(Invoke("set", Account().Append(secret)), R"({"value":true})");
    auto response = base::JSONReader::ReadDict(Invoke("get", Account()),
                                               base::JSON_PARSE_RFC);
    ASSERT_TRUE(response);
    ASSERT_TRUE(response->FindString("value"));
    EXPECT_EQ(*response->FindString("value"), secret);
  }
  EXPECT_EQ(Invoke("delete", Account()), R"({"value":true})");
  EXPECT_EQ(Invoke("delete", Account()), R"({"value":true})");
  EXPECT_EQ(Invoke("get", Account()), R"({"value":null})");
}

TEST_F(KeychainTest, LockedOrAbsentServiceReportsFailureWithoutSaving) {
  fake_->unavailable = true;
  for (const char* method : {"get", "set", "delete"}) {
    auto args = Account();
    if (std::string_view(method) == "set")
      args.Append("never saved");
    Error(Invoke(method, std::move(args)), "credential_error");
  }
  EXPECT_TRUE(fake_->values.empty());
}

TEST_F(KeychainTest, WindowAndCoordinatorShareTheOSUserStore) {
  EXPECT_EQ(Invoke("set", Account().Append("coordinator token")),
            R"({"value":true})");
  testing::NiceMock<KeychainWindow> window;
  ON_CALL(window, GetProfile()).WillByDefault(testing::Return(profile()));
  Reset(HostContext::ForWindow(window));
  EXPECT_EQ(Invoke("get", Account()), R"({"value":"coordinator token"})");
}

TEST_F(KeychainTest, ExpiredProfileRejectsWorkAndLateResults) {
  auto other = std::make_unique<TestingProfile>();
  Reset(HostContext::ForCoordinator(*other));
  base::test::TestFuture<const std::string&> pending;
  auto callback = pending.GetCallback();
  EXPECT_TRUE(keychain_->Dispatch("BayKeychain", "get", Account(), callback));
  other.reset();
  task_environment()->RunUntilIdle();
  Error(pending.Get(), "profile_unavailable");
  const auto calls = fake_->calls.size();
  Error(Invoke("set", Account().Append("token")), "profile_unavailable");
  EXPECT_EQ(fake_->calls.size(), calls);
}

TEST_F(KeychainTest, TeardownSettlesOnceAndOrdersWritesAcrossDocuments) {
  std::vector<std::string> responses;
  auto callback = base::BindLambdaForTesting(
      [&](const std::string& response) { responses.push_back(response); });
  Keychain::Response pending = callback;
  EXPECT_TRUE(keychain_->Dispatch("BayKeychain", "set",
                                  Account().Append("accepted"), pending));
  EXPECT_TRUE(responses.empty());
  keychain_.reset();
  ASSERT_EQ(responses.size(), 1u);
  Error(responses[0], "host_closed");
  Reset(HostContext::ForCoordinator(*profile()));
  EXPECT_EQ(Invoke("get", Account()), R"({"value":"accepted"})");
  EXPECT_EQ(responses.size(), 1u);
  EXPECT_EQ(fake_->calls, (std::vector<std::string>{"set:calendar:café",
                                                    "get:calendar:café"}));
}

TEST_F(KeychainTest, ReplyCanDestroyService) {
  Keychain::Response callback =
      base::BindLambdaForTesting([&](const std::string& response) {
        EXPECT_EQ(response, R"({"value":null})");
        keychain_.reset();
      });
  EXPECT_TRUE(keychain_->Dispatch("BayKeychain", "get", Account(), callback));
  task_environment()->RunUntilIdle();
  EXPECT_FALSE(keychain_);
}
}  // namespace
}  // namespace bay
