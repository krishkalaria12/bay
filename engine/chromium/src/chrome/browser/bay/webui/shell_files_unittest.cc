// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_files.h"

#include <clocale>
#include <memory>
#include <string>
#include <utility>

#include <sys/stat.h>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/test/bind.h"
#include "base/test/scoped_path_override.h"
#include "base/test/test_future.h"
#include "chrome/common/chrome_paths.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "chrome/test/base/testing_profile.h"
#include "content/public/browser/browser_thread.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
class ShellFilesTest : public ChromeRenderViewHostTestHarness {
 public:
  ShellFilesTest()
      : ChromeRenderViewHostTestHarness(
            base::test::TaskEnvironment::ThreadPoolExecutionMode::QUEUED) {}

 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    ASSERT_TRUE(temp_.CreateUniqueTempDir());
    downloads_ = std::make_unique<base::ScopedPathOverride>(
        chrome::DIR_DEFAULT_DOWNLOADS, temp_.GetPath().Append("下载 café"),
        true, false);
    ShellFiles::Operations operations;
    operations.open = base::BindLambdaForTesting(
        [this](Profile* assigned, const base::FilePath& path, bool directory,
               base::OnceCallback<void(bool)> done) {
          EXPECT_TRUE(
              content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
          EXPECT_EQ(assigned, profile());
          ++opens_;
          last_path_ = path;
          directory_ = directory;
          if (hold_open_)
            open_done_ = std::move(done);
          else
            std::move(done).Run(open_result_);
        });
    operations.reveal = base::BindLambdaForTesting(
        [this](Profile* assigned, const base::FilePath& path) {
          EXPECT_TRUE(
              content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
          EXPECT_EQ(assigned, profile());
          ++reveals_;
          last_path_ = path;
          if (close_on_reveal_)
            files_.reset();
        });
    operations.trash =
        base::BindLambdaForTesting([this](const base::FilePath& path) {
          EXPECT_FALSE(
              content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
          ++trashes_;
          EXPECT_EQ(path, File());
          return trash_result_;
        });
    files_ = std::make_unique<ShellFiles>(
        HostContext::ForCoordinator(*profile()), std::move(operations));
  }
  void TearDown() override {
    files_.reset();
    task_environment()->RunUntilIdle();
    downloads_.reset();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  void Prepare() {
    base::test::TestFuture<void> ready;
    files_->Prepare(ready.GetCallback());
    EXPECT_FALSE(ready.IsReady());
    task_environment()->RunUntilIdle();
    EXPECT_TRUE(ready.IsReady());
  }
  base::FilePath File() {
    return temp_.GetPath().Append("café ?*%#'$(literal)\\.txt");
  }
  std::string Invoke(const char* method, base::ListValue args) {
    base::test::TestFuture<const std::string&> result;
    auto callback = result.GetCallback();
    EXPECT_TRUE(files_->Dispatch("BaySystem", method, args, callback));
    task_environment()->RunUntilIdle();
    return result.Get();
  }
  std::string PathCall(const char* method, const base::FilePath& path) {
    return Invoke(method, base::ListValue().Append(path.value()));
  }
  void ExpectError(const std::string& response, const char* code) {
    auto value = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(value);
    ASSERT_TRUE(value->FindStringByDottedPath("error.code"));
    EXPECT_EQ(*value->FindStringByDottedPath("error.code"), code);
  }
  base::ScopedTempDir temp_;
  std::unique_ptr<base::ScopedPathOverride> downloads_;
  std::unique_ptr<ShellFiles> files_;
  base::FilePath last_path_;
  base::OnceCallback<void(bool)> open_done_;
  int opens_ = 0, reveals_ = 0, trashes_ = 0;
  bool directory_ = false, hold_open_ = false, close_on_reveal_ = false;
  bool open_result_ = true, trash_result_ = false;
};

TEST_F(ShellFilesTest, CatalogIsBoundedAndUnhandledCallbackIsUntouched) {
  EXPECT_EQ(ShellFiles::SupportedMethods().size(), 5u);
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  for (const char* method :
       {"fileIcon", "isDefaultBrowser", "setLaunchAtLogin"})
    EXPECT_FALSE(files_->Dispatch("BaySystem", method, {}, callback));
  EXPECT_FALSE(files_->Dispatch("BayApp", "openFile", {}, callback));
  EXPECT_TRUE(callback);
  EXPECT_FALSE(result.IsReady());
}
TEST_F(ShellFilesTest, DownloadsWaitForWorkerAndDoNotCreateTheDirectory) {
  EXPECT_FALSE(files_->ready());
  ExpectError(Invoke("downloadsFolder", {}), "initialization_failed");
  Prepare();
  const auto path = temp_.GetPath().Append("下载 café");
  EXPECT_EQ(files_->downloads_folder(), base::Value(path.value()));
  EXPECT_FALSE(base::PathExists(path));
  auto value = base::JSONReader::ReadDict(Invoke("downloadsFolder", {}),
                                          base::JSON_PARSE_RFC);
  ASSERT_TRUE(value);
  EXPECT_EQ(*value->FindString("value"), path.value());
  base::test::TestFuture<void> again;
  files_->Prepare(again.GetCallback());
  EXPECT_TRUE(again.IsReady());
}
TEST_F(ShellFilesTest, InvalidDownloadsProduceExplicitNull) {
  base::ScopedPathOverride invalid(chrome::DIR_DEFAULT_DOWNLOADS,
                                   base::FilePath("relative"), true);
  Prepare();
  EXPECT_TRUE(files_->downloads_folder().is_none());
  EXPECT_EQ(Invoke("downloadsFolder", {}), R"({"value":null})");
}
TEST_F(ShellFilesTest, RejectsInvalidPathsWithoutExternalEffects) {
  Prepare();
  for (const char* method :
       {"fileExists", "openFile", "revealFile", "moveToTrash"}) {
    for (const auto& value :
         {base::Value(), base::Value(1), base::Value(false), base::Value(""),
          base::Value("relative"), base::Value(std::string("/tmp/a\0b", 8)),
          base::Value(std::string("/tmp/\xff", 6))})
      ExpectError(Invoke(method, base::ListValue().Append(value.Clone())),
                  "invalid_args");
  }
  EXPECT_EQ(opens_ + reveals_ + trashes_, 0);
}
TEST_F(ShellFilesTest, ExistenceFollowsLinksAndAllowsNativeFilenameBytes) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  EXPECT_EQ(PathCall("fileExists", File()), R"({"value":true})");
  EXPECT_EQ(PathCall("fileExists", temp_.GetPath()), R"({"value":true})");
  const auto link = temp_.GetPath().Append("link");
  ASSERT_TRUE(base::CreateSymbolicLink(File(), link));
  EXPECT_EQ(PathCall("fileExists", link), R"({"value":true})");
  ASSERT_TRUE(base::DeleteFile(File()));
  EXPECT_EQ(PathCall("fileExists", link), R"({"value":false})");
}
TEST_F(ShellFilesTest, NativeUtf8BytesSurviveTheCLocale) {
  const std::string saved_locale = std::setlocale(LC_CTYPE, nullptr);
  ASSERT_TRUE(std::setlocale(LC_CTYPE, "C"));
  // Restore even when an assertion returns early.
  base::ScopedClosureRunner restore(base::BindOnce(
      [](std::string locale) { std::setlocale(LC_CTYPE, locale.c_str()); },
      saved_locale));
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  EXPECT_EQ(PathCall("fileExists", File()), R"({"value":true})");
  EXPECT_EQ(PathCall("openFile", File()), R"({"value":true})");
  EXPECT_EQ(last_path_.value(), File().value());
  EXPECT_EQ(files_->downloads_folder(),
            base::Value(temp_.GetPath().Append("下载 café").value()));
}
TEST_F(ShellFilesTest,
       OpensFilesAndDownloadsDirectoriesUsingTheAssignedProfile) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  EXPECT_EQ(PathCall("openFile", File()), R"({"value":true})");
  EXPECT_FALSE(directory_);
  EXPECT_EQ(last_path_, File());
  EXPECT_EQ(PathCall("openFile", temp_.GetPath()), R"({"value":true})");
  EXPECT_TRUE(directory_);
  open_result_ = false;
  EXPECT_EQ(PathCall("openFile", File()), R"({"value":false})");
  EXPECT_EQ(PathCall("openFile", temp_.GetPath().Append("missing")),
            R"({"value":false})");
  EXPECT_EQ(opens_, 3);
}
TEST_F(ShellFilesTest, RevealRequiresAnExistingRegularFileOrDirectory) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  EXPECT_EQ(PathCall("revealFile", File()), R"({"value":true})");
  EXPECT_EQ(last_path_, File());
  EXPECT_EQ(PathCall("revealFile", temp_.GetPath()), R"({"value":true})");
  EXPECT_EQ(PathCall("revealFile", temp_.GetPath().Append("missing")),
            R"({"value":false})");
  EXPECT_EQ(reveals_, 2);
}
TEST_F(ShellFilesTest, SpecialNodesNeverReachTheOpenOrRevealBackend) {
  Prepare();
  const auto fifo = temp_.GetPath().Append("fifo");
  ASSERT_EQ(mkfifo(fifo.value().c_str(), 0600), 0);
  EXPECT_EQ(PathCall("fileExists", fifo), R"({"value":true})");
  EXPECT_EQ(PathCall("openFile", fifo), R"({"value":false})");
  EXPECT_EQ(PathCall("revealFile", fifo), R"({"value":false})");
  EXPECT_EQ(opens_ + reveals_, 0);
}
TEST_F(ShellFilesTest, TrashRejectsGioDirectoryNormalizationBeforeTheBackend) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  for (const auto& suffix : {"/../victim", "/.", "/", "/./child"})
    ExpectError(
        PathCall("moveToTrash", base::FilePath(File().value() + suffix)),
        "invalid_args");
  EXPECT_EQ(trashes_, 0);
  EXPECT_TRUE(base::PathExists(File()));
}
TEST_F(ShellFilesTest, TrashRunsOffUiAndFalseDoesNotDeleteTheFile) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  EXPECT_EQ(PathCall("moveToTrash", File()), R"({"value":false})");
  EXPECT_TRUE(base::PathExists(File()));
  trash_result_ = true;
  EXPECT_EQ(PathCall("moveToTrash", File()), R"({"value":true})");
  EXPECT_EQ(trashes_, 2);
  EXPECT_TRUE(
      base::PathExists(File()));  // Fake backend never trashes anything.
}
TEST_F(ShellFilesTest, ClosingBeforeWorkersReplySettlesEveryRequestOnce) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  int calls = 0;
  for (const char* method :
       {"fileExists", "openFile", "revealFile", "moveToTrash"}) {
    ShellFiles::Response callback =
        base::BindLambdaForTesting([this, &calls](const std::string& response) {
          ++calls;
          ExpectError(response, "host_closed");
        });
    EXPECT_TRUE(files_->Dispatch("BaySystem", method,
                                 base::ListValue().Append(File().value()),
                                 callback));
  }
  EXPECT_EQ(calls, 0);
  files_.reset();
  EXPECT_EQ(calls, 4);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls, 4);
  EXPECT_EQ(opens_ + reveals_, 0);
}
TEST_F(ShellFilesTest, OpenCompletionAndResponseCanReenterOrCloseOwner) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  hold_open_ = true;
  int calls = 0;
  ShellFiles::Response callback =
      base::BindLambdaForTesting([this, &calls](const std::string& response) {
        ++calls;
        EXPECT_EQ(response, R"({"value":true})");
        files_.reset();
      });
  files_->Dispatch("BaySystem", "openFile",
                   base::ListValue().Append(File().value()), callback);
  task_environment()->RunUntilIdle();
  ASSERT_TRUE(open_done_);
  std::move(open_done_).Run(true);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls, 1);
}
TEST_F(ShellFilesTest, LateOpenCompletionAfterCloseDoesNotReplyTwice) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  hold_open_ = true;
  int calls = 0;
  ShellFiles::Response callback =
      base::BindLambdaForTesting([this, &calls](const std::string& response) {
        ++calls;
        ExpectError(response, "host_closed");
      });
  files_->Dispatch("BaySystem", "openFile",
                   base::ListValue().Append(File().value()), callback);
  task_environment()->RunUntilIdle();
  ASSERT_TRUE(open_done_);
  files_.reset();
  std::move(open_done_).Run(true);
  EXPECT_EQ(calls, 1);
}
TEST_F(ShellFilesTest, RevealBackendCanCloseOwnerBeforeReturning) {
  Prepare();
  ASSERT_TRUE(base::WriteFile(File(), "safe"));
  close_on_reveal_ = true;
  ExpectError(PathCall("revealFile", File()), "host_closed");
}
TEST_F(ShellFilesTest, PreparationCallbackCanDeleteOwner) {
  files_->Prepare(base::BindLambdaForTesting([this] { files_.reset(); }));
  task_environment()->RunUntilIdle();
  EXPECT_FALSE(files_);
}
TEST_F(ShellFilesTest, ExpiredAssignedProfileWinsOverReadinessAndInvalidArgs) {
  auto other = std::make_unique<TestingProfile>();
  ShellFiles orphan(HostContext::ForCoordinator(*other));
  other.reset();
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  EXPECT_TRUE(orphan.Dispatch("BaySystem", "openFile", {}, callback));
  ExpectError(result.Get(), "profile_unavailable");
}
}  // namespace
}  // namespace bay
