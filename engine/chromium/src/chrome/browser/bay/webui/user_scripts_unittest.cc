// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/user_scripts.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "build/build_config.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "testing/gtest/include/gtest/gtest.h"

#if BUILDFLAG(IS_POSIX)
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#include "base/files/scoped_file.h"
#endif

namespace bay {
namespace {
class UserScriptsTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    ASSERT_TRUE(temp_.CreateUniqueTempDir());
    scripts_ = temp_.GetPath().AppendASCII("Scripts");
    extension_ = scripts_.AppendASCII("extension");
  }
  void Publish() {
    ASSERT_TRUE(base::CreateDirectory(extension_.AppendASCII("js")));
    ASSERT_TRUE(base::WriteFile(scripts_.AppendASCII("generation"), "1\n"));
    ASSERT_TRUE(base::WriteFile(extension_.AppendASCII("generation"), "1\n"));
    ASSERT_TRUE(base::WriteFile(extension_.AppendASCII("js/a.js"), "void 0"));
    ASSERT_TRUE(base::WriteFile(extension_.AppendASCII("manifest.json"),
        R"({"manifest_version":3,"name":"Bay Scripts","version":"1.0.1","content_scripts":[{"matches":["https://example.com/*"],"js":["js/a.js"]}]})"));
  }
  std::string State() {
    auto value = UserScripts::Read(scripts_);
    return *value.FindString("state");
  }
  base::ScopedTempDir temp_;
  base::FilePath scripts_;
  base::FilePath extension_;
};

TEST_F(UserScriptsTest, EmptyReadyPendingAndUninstalledGenerations) {
  EXPECT_EQ(State(), "empty");
  Publish();
  auto ready = UserScripts::Read(scripts_);
  EXPECT_EQ(*ready.FindString("state"), "ready");
  EXPECT_EQ(ready.FindDouble("generation"), 1);
  EXPECT_EQ(*ready.FindString("path"),
            base::MakeAbsoluteFilePath(extension_).AsUTF8Unsafe());
  const auto token = *ready.FindString("token");
  EXPECT_EQ(*UserScripts::Read(scripts_).FindString("token"), token);
  ASSERT_TRUE(base::WriteFile(scripts_.AppendASCII("generation"), "2\n"));
  EXPECT_EQ(State(), "pending");
  ASSERT_TRUE(base::DeletePathRecursively(extension_));
  EXPECT_EQ(State(), "absent");
}

TEST_F(UserScriptsTest, RefusesPermissionsMissingFilesAndUnsafeGenerations) {
  Publish();
  ASSERT_TRUE(base::WriteFile(extension_.AppendASCII("manifest.json"),
      R"({"manifest_version":3,"name":"Bay Scripts","version":"1","permissions":["cookies"],"content_scripts":[{"matches":["<all_urls>"],"js":["js/a.js"]}]})"));
  EXPECT_EQ(State(), "invalid");
  Publish();
  ASSERT_TRUE(base::DeleteFile(extension_.AppendASCII("js/a.js")));
  EXPECT_EQ(State(), "invalid");
  Publish();
  ASSERT_TRUE(base::WriteFile(extension_.AppendASCII("generation"), "9007199254740992\n"));
  EXPECT_EQ(State(), "pending");
}

TEST_F(UserScriptsTest, InterruptedExchangeWaitsForCliRecovery) {
  Publish();
  const auto journal = scripts_.AppendASCII(".swap-012345abcdef.json");
  ASSERT_TRUE(base::WriteFile(journal, "{}"));
  EXPECT_EQ(State(), "pending");
  ASSERT_TRUE(base::DeleteFile(journal));
  EXPECT_EQ(State(), "ready");
}

#if BUILDFLAG(IS_POSIX)
TEST_F(UserScriptsTest, CoordinatesWithCliFlock) {
  Publish();
  const auto path = scripts_.AppendASCII(".lock");
  base::ScopedFD writer(open(path.value().c_str(), O_RDWR | O_CREAT, 0600));
  ASSERT_TRUE(writer.is_valid());
  ASSERT_EQ(flock(writer.get(), LOCK_EX | LOCK_NB), 0);
  EXPECT_EQ(State(), "busy");
  writer.reset();
  EXPECT_EQ(State(), "ready");
}
TEST_F(UserScriptsTest, RejectsLinkedFoldersAndSources) {
  Publish();
  const auto outside = temp_.GetPath().AppendASCII("outside.js");
  ASSERT_TRUE(base::WriteFile(outside, "secret"));
  const auto source = extension_.AppendASCII("js/a.js");
  ASSERT_TRUE(base::DeleteFile(source));
  ASSERT_TRUE(base::CreateSymbolicLink(outside, source));
  EXPECT_EQ(State(), "invalid");
  ASSERT_TRUE(base::DeleteFile(source));
  ASSERT_EQ(link(outside.value().c_str(), source.value().c_str()), 0);
  EXPECT_EQ(State(), "invalid");
}
#endif

TEST_F(UserScriptsTest, StatusIsBoundedJsonAndPreservesThePublishedExtension) {
  Publish();
  EXPECT_TRUE(UserScripts::ReadStatus(scripts_).is_none());
  EXPECT_TRUE(UserScripts::WriteStatus(scripts_, R"({"generation":1})"));
  EXPECT_EQ(UserScripts::ReadStatus(scripts_).GetString(), R"({"generation":1})");
  // Status is allowed to change the folder's token, but not the generation.
  EXPECT_EQ(State(), "ready");
  EXPECT_FALSE(UserScripts::WriteStatus(scripts_, "not json"));
  EXPECT_FALSE(UserScripts::WriteStatus(scripts_, std::string(1048577, 'x')));
  EXPECT_EQ(UserScripts::ReadStatus(scripts_).GetString(), R"({"generation":1})");
}

TEST_F(UserScriptsTest, RejectsMalformedCallsAndLeavesOtherModulesUntouched) {
  UserScripts scripts(scripts_, base::BindRepeating([] {}));
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  EXPECT_FALSE(scripts.Dispatch("BayShell", "read", {}, callback));
  EXPECT_TRUE(callback);
  EXPECT_TRUE(scripts.Dispatch("BayUserScripts", "watch", {}, callback));
  EXPECT_NE(result.Get().find("invalid_args"), std::string::npos);
}
}  // namespace
}  // namespace bay
