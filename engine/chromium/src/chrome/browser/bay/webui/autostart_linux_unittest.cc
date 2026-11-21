// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/autostart_linux.h"

#include <sys/stat.h>
#include <unistd.h>

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/containers/span.h"
#include "base/files/file.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/test/bind.h"
#include "base/test/test_future.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "chrome/test/base/testing_profile.h"
#include "content/public/browser/browser_thread.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
using Result = Autostart::Result;
using Paths = Autostart::Paths;

class AutostartTest : public ChromeRenderViewHostTestHarness {
 public:
  AutostartTest()
      : ChromeRenderViewHostTestHarness(
            base::test::TaskEnvironment::ThreadPoolExecutionMode::QUEUED) {}

 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    ASSERT_TRUE(temp_.CreateUniqueTempDir());
    // Resolve macOS /var and /tmp aliases too, if this POSIX fixture is reused.
    root_ = base::MakeAbsoluteFilePath(temp_.GetPath());
    ASSERT_FALSE(root_.empty());
    paths_.config_home = root_.Append("config").value();
    paths_.home = root_.Append("home").value();
    ASSERT_TRUE(base::CreateDirectory(base::FilePath(*paths_.home)));
    paths_.executable = root_.Append("bay");
    MakeExecutable(paths_.executable);
    Reset();
  }
  void TearDown() override {
    autostart_.reset();
    task_environment()->RunUntilIdle();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  Autostart::Operations NativeOperations() {
    Autostart::Operations operations;
    // Values are copied before posting; no worker reads a UI-owned object.
    operations.paths = base::BindRepeating(
        [](Paths paths) {
          EXPECT_FALSE(
              content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
          return paths;
        },
        paths_);
    return operations;
  }
  void Reset() {
    autostart_ = std::make_unique<Autostart>(
        HostContext::ForCoordinator(*profile()), NativeOperations());
  }
  void MakeExecutable(const base::FilePath& path) {
    ASSERT_TRUE(base::WriteFile(path, "fixture, never executed"));
    ASSERT_TRUE(base::SetPosixFilePermissions(path, 0700));
  }
  base::FilePath Config() { return base::FilePath(*paths_.config_home); }
  base::FilePath Directory() { return Config().Append("autostart"); }
  base::FilePath Entry() { return Directory().Append("bay.desktop"); }
  std::string Contents() {
    std::string contents;
    EXPECT_TRUE(base::ReadFileToString(Entry(), &contents));
    return contents;
  }
  std::string Invoke(const char* method, base::ListValue args = {}) {
    base::test::TestFuture<const std::string&> result;
    auto callback = result.GetCallback();
    EXPECT_TRUE(autostart_->Dispatch("BaySystem", method, args, callback));
    EXPECT_FALSE(callback);
    task_environment()->RunUntilIdle();
    return result.Get();
  }
  std::string Set(bool enabled) {
    return Invoke("setLaunchAtLogin", base::ListValue().Append(enabled));
  }
  std::string Status() { return Invoke("launchAtLoginStatus"); }
  void Error(const std::string& response, const char* code) {
    auto value = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(value);
    const auto* actual = value->FindStringByDottedPath("error.code");
    ASSERT_TRUE(actual);
    EXPECT_EQ(*actual, code);
  }
  void OnlyEntryRemains() {
    base::FileEnumerator files(Directory(), false, base::FileEnumerator::FILES);
    EXPECT_EQ(files.Next(), Entry());
    EXPECT_TRUE(files.Next().empty());
  }
  base::ScopedTempDir temp_;
  base::FilePath root_;
  Paths paths_;
  std::unique_ptr<Autostart> autostart_;
};

TEST_F(AutostartTest, CatalogAndUnhandledCallbacksAreBounded) {
  auto methods = Autostart::SupportedMethods();
  EXPECT_EQ(methods.size(), 2u);
  EXPECT_TRUE(methods.contains("BaySystem.launchAtLoginStatus"));
  EXPECT_TRUE(methods.contains("BaySystem.setLaunchAtLogin"));
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  EXPECT_FALSE(
      autostart_->Dispatch("BayApp", "setLaunchAtLogin", {}, callback));
  EXPECT_FALSE(
      autostart_->Dispatch("BaySystem", "isDefaultBrowser", {}, callback));
  EXPECT_TRUE(callback);
  EXPECT_FALSE(result.IsReady());
}

TEST_F(AutostartTest, InvalidArgumentsDoNotTouchDisk) {
  for (const char* json :
       {"[]", "[null]", "[0]", "[\"true\"]", "[{}]", "[[]]", "[true,false]"}) {
    auto args = base::JSONReader::ReadList(json, base::JSON_PARSE_RFC);
    ASSERT_TRUE(args);
    Error(Invoke("setLaunchAtLogin", std::move(*args)), "invalid_args");
  }
  Error(Invoke("launchAtLoginStatus", base::ListValue().Append(false)),
        "invalid_args");
  EXPECT_FALSE(base::PathExists(Config()));
}

TEST_F(AutostartTest, MissingQueryDoesNotCreateAndToggleIsIdempotent) {
  EXPECT_EQ(Status(), R"({"value":"notRegistered"})");
  EXPECT_FALSE(base::PathExists(Config()));
  EXPECT_EQ(Set(true), R"({"value":null})");
  const auto enabled = Contents();
  EXPECT_EQ(Status(), R"({"value":"enabled"})");
  EXPECT_EQ(Set(true), R"({"value":null})");
  EXPECT_EQ(Contents(), enabled);
  EXPECT_EQ(Set(false), R"({"value":null})");
  EXPECT_EQ(Status(), R"({"value":"notRegistered"})");
  EXPECT_EQ(Contents(),
            "[Desktop Entry]\nX-Bay-Autostart-Version=1\nHidden=true\n");
  EXPECT_EQ(Set(false), R"({"value":null})");
  EXPECT_EQ(Set(true), R"({"value":null})");
  EXPECT_EQ(Contents(), enabled);
  int mode = 0;
  ASSERT_TRUE(base::GetPosixFilePermissions(Entry(), &mode));
  EXPECT_EQ(mode, 0600);
  OnlyEntryRemains();
}

TEST_F(AutostartTest, AtomicReplacementPreservesAlreadyOpenedEntry) {
  ASSERT_EQ(Set(true), R"({"value":null})");
  const auto before = Contents();
  base::File previous(Entry(), base::File::FLAG_OPEN | base::File::FLAG_READ);
  ASSERT_TRUE(previous.IsValid());
  ASSERT_EQ(Set(false), R"({"value":null})");
  std::string old_contents(before.size(), '\0');
  EXPECT_EQ(
      previous.ReadAtCurrentPos(base::as_writable_byte_span(old_contents)),
      std::make_optional(before.size()));
  EXPECT_EQ(old_contents, before);
  EXPECT_NE(Contents(), before);
  OnlyEntryRemains();
}

TEST_F(AutostartTest, InstalledWrapperSymlinkKeepsItsOwnPath) {
  const auto wrapper = root_.Append("bay wrapper");
  ASSERT_TRUE(base::CreateSymbolicLink(paths_.executable, wrapper));
  paths_.executable = wrapper;
  Reset();
  EXPECT_EQ(Set(true), R"({"value":null})");
  EXPECT_NE(Contents().find("Exec=\"" + wrapper.value() + "\" "),
            std::string::npos);
  EXPECT_EQ(Status(), R"({"value":"enabled"})");
}

TEST_F(AutostartTest, DisableCreatesAHiddenOverrideEvenWithoutExecutable) {
  paths_.executable = {};
  Reset();
  EXPECT_EQ(Set(false), R"({"value":null})");
  EXPECT_EQ(Status(), R"({"value":"notRegistered"})");
  EXPECT_TRUE(base::PathExists(Entry()));
}

TEST_F(AutostartTest, QuotesExecutableAsOneLiteralArgumentWithTwoEscapeLayers) {
  paths_.executable =
      root_.Append("Bay space %f %U \"quote\" \\ $HOME `id` 'café';");
  MakeExecutable(paths_.executable);
  Reset();
  ASSERT_EQ(Set(true), R"({"value":null})");
  // Expected bytes are independent of the production parser/encoder.
  const std::string expected =
      "Exec=\"" + root_.value() +
      R"(/Bay space %%f %%U \"quote\" \\ \$HOME \`id\` 'café';" --bay-launch-at-login)";
  EXPECT_NE(Contents().find(expected + "\n"), std::string::npos);
  EXPECT_EQ(Status(), R"({"value":"enabled"})");
  OnlyEntryRemains();
}

TEST_F(AutostartTest, RejectsInvalidOrMissingExecutablesBeforeCreatingConfig) {
  for (const char* path : {"", "relative/bay", "/missing/bay",
                           "/tmp/bay\nExec=evil", "/tmp/bay=invalid"}) {
    paths_.executable = base::FilePath(path);
    Reset();
    Error(Set(true), "path_error");
    EXPECT_FALSE(base::PathExists(Config()));
  }
  paths_.executable = root_;
  Reset();
  Error(Set(true), "path_error");
  paths_.executable = root_.Append("bay");
  ASSERT_TRUE(base::SetPosixFilePermissions(paths_.executable, 0600));
  Reset();
  Error(Set(true), "path_error");
}

TEST_F(AutostartTest, MissingInstalledPathReportsNotFoundAndCanBeReplaced) {
  ASSERT_EQ(Set(true), R"({"value":null})");
  ASSERT_TRUE(base::DeleteFile(paths_.executable));
  EXPECT_EQ(Status(), R"({"value":"notFound"})");
  paths_.executable = root_.Append("new wrapper");
  MakeExecutable(paths_.executable);
  Reset();
  EXPECT_EQ(Set(true), R"({"value":null})");
  EXPECT_EQ(Status(), R"({"value":"enabled"})");
  EXPECT_NE(Contents().find("new wrapper"), std::string::npos);
}

TEST_F(AutostartTest,
       HomeFallbackForUnsetEmptyOrRelativeXdgAndAbsoluteXdgWins) {
  for (auto config :
       {std::optional<std::string>(), std::make_optional(std::string()),
        std::make_optional(std::string("relative/config"))}) {
    paths_.config_home = config;
    Reset();
    EXPECT_EQ(Set(true), R"({"value":null})");
    EXPECT_TRUE(base::PathExists(
        base::FilePath(*paths_.home).Append(".config/autostart/bay.desktop")));
    EXPECT_EQ(Status(), R"({"value":"enabled"})");
  }
  paths_.config_home = root_.Append("xdg").value();
  paths_.home.reset();
  Reset();
  EXPECT_EQ(Set(true), R"({"value":null})");
  EXPECT_TRUE(base::PathExists(Entry()));
}

TEST_F(AutostartTest, InvalidHomeOrAbsoluteXdgFailsWithoutFallback) {
  for (const char* home : {"", "relative", "/tmp/../bad", "/tmp/bad\nhome"}) {
    paths_.config_home.reset();
    paths_.home = home;
    Reset();
    Error(Set(false), "autostart_unavailable");
  }
  paths_.home.reset();
  Reset();
  Error(Status(), "autostart_unavailable");
  for (const char* config : {"/", "/tmp/../bad", "/tmp/bad\nconfig"}) {
    paths_.config_home = config;
    paths_.home = root_.value();
    Reset();
    Error(Set(false), "autostart_unavailable");
  }
}

TEST_F(AutostartTest,
       EmbeddedNulInEnvironmentIsRefusedBeforeFilePathConversion) {
  paths_.config_home = Config().value() + std::string("\0suffix", 7);
  Reset();
  Error(Set(false), "autostart_unavailable");
  paths_.config_home.reset();
  paths_.home = root_.value() + std::string("\0suffix", 7);
  Reset();
  Error(Set(false), "autostart_unavailable");
  EXPECT_FALSE(base::PathExists(root_.Append(".config")));
}

TEST_F(AutostartTest, DoesNotOverwriteCustomEntriesEvenWithCopiedMarker) {
  ASSERT_TRUE(base::CreateDirectory(Directory()));
  for (const char* content :
       {"[Desktop Entry]\nType=Application\nName=Custom\nExec=/custom\n",
        "[Desktop "
        "Entry]\nX-Bay-Autostart-Version=1\nHidden=true\nCustom=keep\n"}) {
    ASSERT_TRUE(base::WriteFile(Entry(), content));
    Error(Status(), "autostart_conflict");
    Error(Set(true), "autostart_conflict");
    Error(Set(false), "autostart_conflict");
    EXPECT_EQ(Contents(), content);
  }
  ASSERT_TRUE(base::DeleteFile(Entry()));
  ASSERT_EQ(Set(true), R"({"value":null})");
  const auto original = Contents();
  auto nul_entry = original;
  nul_entry.insert(nul_entry.find(" --bay-launch-at-login") - 1,
                   std::string("\0suffix", 7));
  ASSERT_TRUE(base::WriteFile(Entry(), nul_entry));
  Error(Set(false), "autostart_conflict");
  EXPECT_EQ(Contents(), nul_entry);
  ASSERT_TRUE(base::WriteFile(Entry(), original + "X-Custom=keep\n"));
  Error(Set(false), "autostart_conflict");
  EXPECT_EQ(Contents(), original + "X-Custom=keep\n");
}

TEST_F(AutostartTest, RecognizesHiddenManagedEntry) {
  ASSERT_EQ(Set(true), R"({"value":null})");
  auto content = Contents();
  content.replace(content.find("Hidden=false"), 12, "Hidden=true");
  ASSERT_TRUE(base::WriteFile(Entry(), content));
  EXPECT_EQ(Status(), R"({"value":"notRegistered"})");
  EXPECT_EQ(Set(true), R"({"value":null})");
}

TEST_F(AutostartTest, SymlinkEntryNeverTouchesTarget) {
  ASSERT_TRUE(base::CreateDirectory(Directory()));
  const auto target = root_.Append("unrelated");
  ASSERT_TRUE(base::WriteFile(target, "keep"));
  ASSERT_TRUE(base::CreateSymbolicLink(target, Entry()));
  Error(Status(), "autostart_unavailable");
  Error(Set(true), "autostart_unavailable");
  Error(Set(false), "autostart_unavailable");
  std::string content;
  ASSERT_TRUE(base::ReadFileToString(target, &content));
  EXPECT_EQ(content, "keep");
  EXPECT_TRUE(base::IsLink(Entry()));
}

TEST_F(AutostartTest, TrustedSymlinkedConfigRootAndHomeAreAccepted) {
  const auto target = root_.Append("config target");
  ASSERT_TRUE(base::CreateDirectory(target));
  ASSERT_TRUE(base::CreateSymbolicLink(target, Config()));
  EXPECT_EQ(Set(true), R"({"value":null})");
  EXPECT_EQ(Status(), R"({"value":"enabled"})");
  EXPECT_TRUE(base::PathExists(target.Append("autostart/bay.desktop")));
  EXPECT_EQ(Set(false), R"({"value":null})");
  EXPECT_EQ(Status(), R"({"value":"notRegistered"})");

  const auto home_link = root_.Append("home link");
  ASSERT_TRUE(
      base::CreateSymbolicLink(base::FilePath(*paths_.home), home_link));
  paths_.config_home.reset();
  paths_.home = home_link.value();
  Reset();
  EXPECT_EQ(Set(true), R"({"value":null})");
  EXPECT_EQ(Status(), R"({"value":"enabled"})");
  EXPECT_TRUE(
      base::PathExists(home_link.Append(".config/autostart/bay.desktop")));
}

TEST_F(AutostartTest, SymlinkAutostartChildIsRefusedWithoutTouchingTarget) {
  const auto target = root_.Append("target");
  ASSERT_TRUE(base::CreateDirectory(target));
  const auto unrelated = target.Append("bay.desktop");
  ASSERT_TRUE(base::WriteFile(unrelated, "keep"));
  ASSERT_TRUE(base::CreateDirectory(Config()));
  ASSERT_TRUE(base::CreateSymbolicLink(target, Directory()));
  Error(Status(), "autostart_unavailable");
  Error(Set(true), "autostart_unavailable");
  Error(Set(false), "autostart_unavailable");
  std::string contents;
  ASSERT_TRUE(base::ReadFileToString(unrelated, &contents));
  EXPECT_EQ(contents, "keep");
  EXPECT_TRUE(base::IsLink(Directory()));
}

TEST_F(AutostartTest, RefusesUnreadableWritableByOthersOrUnownedConfiguration) {
  ASSERT_TRUE(base::CreateDirectory(Directory()));
  for (int mode : {0300, 0600, 0777}) {
    ASSERT_TRUE(base::SetPosixFilePermissions(Config(), mode));
    Error(Status(), "autostart_unavailable");
    Error(Set(false), "autostart_unavailable");
    ASSERT_TRUE(base::SetPosixFilePermissions(Config(), 0700));
  }
  for (int mode : {0300, 0600, 0777}) {
    ASSERT_TRUE(base::SetPosixFilePermissions(Directory(), mode));
    Error(Status(), "autostart_unavailable");
    Error(Set(false), "autostart_unavailable");
    ASSERT_TRUE(base::SetPosixFilePermissions(Directory(), 0700));
  }
  // Ownership changes are testable only when privileged; no user files touched.
  if (geteuid() == 0) {
    ASSERT_EQ(chown(Config().value().c_str(), 12345, static_cast<gid_t>(-1)),
              0);
    Error(Set(false), "autostart_unavailable");
    ASSERT_EQ(chown(Config().value().c_str(), 0, static_cast<gid_t>(-1)), 0);
  }
  EXPECT_FALSE(base::PathExists(Entry()));
}

TEST_F(AutostartTest, RefusesDirectoryFifoHardlinkAndUnreadableEntry) {
  ASSERT_TRUE(base::CreateDirectory(Entry()));
  Error(Set(false), "autostart_unavailable");
  ASSERT_TRUE(base::DeleteFile(Entry()));
  ASSERT_EQ(mkfifo(Entry().value().c_str(), 0600), 0);
  Error(Set(false), "autostart_unavailable");
  ASSERT_TRUE(base::DeleteFile(Entry()));
  ASSERT_EQ(Set(true), R"({"value":null})");
  const auto before = Contents();
  ASSERT_EQ(
      link(Entry().value().c_str(), root_.Append("linked").value().c_str()), 0);
  Error(Set(false), "autostart_unavailable");
  EXPECT_EQ(Contents(), before);
  ASSERT_TRUE(base::DeleteFile(root_.Append("linked")));
  ASSERT_TRUE(base::SetPosixFilePermissions(Entry(), 0200));
  Error(Set(false), "autostart_unavailable");
  ASSERT_TRUE(base::SetPosixFilePermissions(Entry(), 0600));
  EXPECT_EQ(Contents(), before);
}

TEST_F(AutostartTest,
       FailedWritePreservesExistingEntryAndLeavesNoTemporaryFile) {
  ASSERT_EQ(Set(true), R"({"value":null})");
  const auto before = Contents();
  ASSERT_TRUE(base::SetPosixFilePermissions(Directory(), 0500));
  Error(Set(false), "autostart_unavailable");
  ASSERT_TRUE(base::SetPosixFilePermissions(Directory(), 0700));
  EXPECT_EQ(Contents(), before);
  OnlyEntryRemains();
}

TEST_F(AutostartTest, RequestsAcrossHostsRunOffUiInAcceptedOrder) {
  std::vector<std::optional<bool>> calls;
  Autostart::Operations operations;
  operations.paths = NativeOperations().paths;
  operations.update = base::BindLambdaForTesting(
      [&calls](const Paths&, std::optional<bool> enabled) {
        EXPECT_FALSE(
            content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
        calls.push_back(enabled);
        return enabled ? Result::kSuccess : Result::kNotRegistered;
      });
  autostart_ = std::make_unique<Autostart>(
      HostContext::ForCoordinator(*profile()), operations);
  auto* otr = profile()->GetPrimaryOTRProfile(true);
  Autostart sibling(HostContext::ForCoordinator(*otr), operations);
  base::test::TestFuture<const std::string&> first, second, third;
  auto a = first.GetCallback();
  auto b = second.GetCallback();
  auto c = third.GetCallback();
  EXPECT_TRUE(autostart_->Dispatch("BaySystem", "setLaunchAtLogin",
                                   base::ListValue().Append(true), a));
  EXPECT_TRUE(sibling.Dispatch("BaySystem", "setLaunchAtLogin",
                               base::ListValue().Append(false), b));
  EXPECT_TRUE(autostart_->Dispatch("BaySystem", "launchAtLoginStatus", {}, c));
  EXPECT_TRUE(calls.empty());
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls,
            (std::vector<std::optional<bool>>{true, false, std::nullopt}));
  EXPECT_EQ(first.Get(), R"({"value":null})");
  EXPECT_EQ(second.Get(), R"({"value":null})");
  EXPECT_EQ(third.Get(), R"({"value":"notRegistered"})");
}

TEST_F(AutostartTest, BackendFailuresAreReportedAndResponseCanDestroyOwner) {
  for (const auto result : {Result::kConfigError, Result::kConflict,
                            Result::kWriteError, Result::kPathError}) {
    Autostart::Operations operations = NativeOperations();
    operations.update = base::BindRepeating(
        [](Result result, const Paths&, std::optional<bool>) { return result; },
        result);
    autostart_ = std::make_unique<Autostart>(
        HostContext::ForCoordinator(*profile()), operations);
    int replies = 0;
    Autostart::Response callback = base::BindLambdaForTesting(
        [this, &replies](const std::string& response) {
          EXPECT_NE(response.find("error"), std::string::npos);
          ++replies;
          autostart_.reset();
        });
    ASSERT_TRUE(autostart_->Dispatch("BaySystem", "setLaunchAtLogin",
                                     base::ListValue().Append(true), callback));
    task_environment()->RunUntilIdle();
    EXPECT_EQ(replies, 1);
    EXPECT_FALSE(autostart_);
  }
}

TEST_F(AutostartTest,
       TeardownSettlesOnceButAcceptedWriteFinishesBeforeNewQuery) {
  int replies = 0;
  Autostart::Response callback =
      base::BindLambdaForTesting([this, &replies](const std::string& response) {
        Error(response, "host_closed");
        ++replies;
      });
  ASSERT_TRUE(autostart_->Dispatch("BaySystem", "setLaunchAtLogin",
                                   base::ListValue().Append(true), callback));
  autostart_.reset();
  EXPECT_EQ(replies, 1);
  EXPECT_FALSE(base::PathExists(Config()));
  Reset();
  EXPECT_EQ(Status(), R"({"value":"enabled"})");
  EXPECT_EQ(replies, 1);
}

TEST_F(AutostartTest, ExpiredAssignedProfileRejectsDispatchAndPendingReply) {
  auto assigned = TestingProfile::Builder().Build();
  autostart_ = std::make_unique<Autostart>(
      HostContext::ForCoordinator(*assigned), NativeOperations());
  base::test::TestFuture<const std::string&> reply;
  auto callback = reply.GetCallback();
  ASSERT_TRUE(autostart_->Dispatch("BaySystem", "setLaunchAtLogin",
                                   base::ListValue().Append(true), callback));
  assigned.reset();
  task_environment()->RunUntilIdle();
  Error(reply.Get(), "profile_unavailable");
  Error(Set(false), "profile_unavailable");
  EXPECT_TRUE(base::PathExists(Entry()));
}
}  // namespace
}  // namespace bay
