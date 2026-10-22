// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/native_host.h"

#include <string>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "chrome/browser/bay/webui/shell_ui.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {

class NativeHostTest : public ChromeRenderViewHostTestHarness {
public:
  NativeHostTest()
      : ChromeRenderViewHostTestHarness(
            base::test::TaskEnvironment::ThreadPoolExecutionMode::QUEUED) {}

protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    auto *host =
        new NativeHost(*main_rfh(), HostContext::ForCoordinator(*profile()),
                       remote_.BindNewPipeAndPassReceiver());
    host_ = host->GetWeakPtr();
  }
  void TearDown() override {
    if (host_)
      host_->ResetAndDeleteThis();
    remote_.reset();
    task_environment()->RunUntilIdle();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  std::string Invoke(const std::string &module, const std::string &method,
                     const std::string &args) {
    base::test::TestFuture<const std::string &> result;
    host_->Invoke(module, method, args, result.GetCallback());
    return result.Get();
  }
  void ExpectError(const std::string &response, const char *code) {
    auto parsed = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(parsed);
    const auto *error = parsed->FindStringByDottedPath("error.code");
    ASSERT_TRUE(error);
    EXPECT_EQ(*error, code);
  }

  mojo::Remote<mojom::NativeHost> remote_;
  base::WeakPtr<NativeHost> host_;
};

TEST_F(NativeHostTest, AdvertisesOnlyImplementedShellAndSystemMethods) {
  base::test::TestFuture<const std::string &> result;
  host_->GetHostInfo(result.GetCallback());
  auto info = base::JSONReader::ReadDict(result.Get(), base::JSON_PARSE_RFC);
  ASSERT_TRUE(info);
  const auto *modules = info->FindList("modules");
  const auto *methods = info->FindList("optionalMethods");
  ASSERT_TRUE(modules);
  ASSERT_TRUE(methods);
  EXPECT_TRUE(modules->contains("BaySystem"));
  EXPECT_TRUE(methods->contains("BayShell.prompt"));
  EXPECT_TRUE(methods->contains("BaySystem.fileIcon"));
  for (const auto &method : *methods) {
    const auto &name = method.GetString();
    if (name.starts_with("BaySystem."))
      EXPECT_EQ(name, "BaySystem.fileIcon");
  }
  EXPECT_FALSE(methods->contains("BayShell.confirm"));
  EXPECT_FALSE(methods->contains("BayShell.readDocument"));
  EXPECT_TRUE(info->FindDictByDottedPath("snapshots.BaySystem.files"));
  const auto *downloads =
      info->FindByDottedPath("snapshots.BaySystem.downloadsFolder");
  ASSERT_TRUE(downloads);
  EXPECT_TRUE(downloads->is_none());
}

TEST_F(NativeHostTest, CoordinatorPromptRequiresAnExplicitLiveWindow) {
  ExpectError(Invoke("BayShell", "prompt", R"([{"title":"Input"}])"),
              "window_required");
  ExpectError(Invoke("BayShell", "prompt",
                     R"([{"title":"Input","windowId":"missing"}])"),
              "window_required");
}

TEST_F(NativeHostTest, ValidatesArgumentsBeforeStartingShellWork) {
  ExpectError(Invoke("BayShell", "prompt", "[]"), "invalid_args");
  ExpectError(Invoke("BayShell", "prompt", "[{}]"), "invalid_args");
  ExpectError(Invoke("BaySystem", "fileIcon", R"(["../file.txt",16])"),
              "invalid_args");
  ExpectError(Invoke("BaySystem", "notAMethod", "[]"), "unknown_method");
}

TEST_F(NativeHostTest, UnhandledShellDispatchLeavesTheCallbackUntouched) {
  ShellUI shell;
  bool called = false;
  ShellUI::Response callback = base::BindOnce(
      [](bool *called, const std::string &) { *called = true; }, &called);
  EXPECT_FALSE(shell.Dispatch(HostContext::ForCoordinator(*profile()),
                              "BayShell", "confirm", {}, callback));
  EXPECT_FALSE(called);
  ASSERT_TRUE(callback);
  std::move(callback).Run("unused");
  EXPECT_TRUE(called);
}

TEST_F(NativeHostTest,
       HostDestructionSettlesIconsOnceBeforeLateLoadCompletion) {
  std::vector<std::string> responses;
  for (const char *args : {R"(["missing.txt",16])", R"(["missing.pdf",32])"}) {
    host_->Invoke(
        "BaySystem", "fileIcon", args,
        base::BindOnce(
            [](std::vector<std::string> *responses,
               const std::string &response) { responses->push_back(response); },
            &responses));
  }
  // QUEUED keeps IconLoader's MIME tasks pending until we drain them below.
  EXPECT_TRUE(responses.empty());
  host_->ResetAndDeleteThis();
  EXPECT_FALSE(host_);
  ASSERT_EQ(responses.size(), 2u);
  for (const auto &response : responses) {
    auto parsed = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(parsed);
    const auto *value = parsed->Find("value");
    ASSERT_TRUE(value);
    EXPECT_TRUE(value->is_none());
  }
  // The real self-deleting loaders still reply after their owner is gone.
  task_environment()->RunUntilIdle();
  EXPECT_EQ(responses.size(), 2u);
}

} // namespace
} // namespace bay
