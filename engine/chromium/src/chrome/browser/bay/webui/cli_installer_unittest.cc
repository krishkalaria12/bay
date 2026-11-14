// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/cli_installer.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/base_paths.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "base/test/bind.h"
#include "base/scoped_environment_variable_override.h"
#include "base/test/scoped_path_override.h"
#include "base/test/test_future.h"
#include "build/build_config.h"
#include "chrome/test/base/testing_profile.h"
#include "content/public/test/browser_task_environment.h"
#include "crypto/sha2.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
#if BUILDFLAG(IS_WIN)
constexpr char kName[] = "bay.exe";
constexpr char kPlatform[] = "windows-x64";
#else
constexpr char kName[] = "bay";
constexpr char kPlatform[] = "linux-x64";
#endif

class CliInstallerTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(root_.CreateUniqueTempDir());
    paths_.bundle = root_.GetPath().AppendASCII("bundle");
    paths_.home = root_.GetPath().AppendASCII("home");
    paths_.bin = root_.GetPath().AppendASCII("bin");
    paths_.isolated = true;
    ASSERT_TRUE(base::CreateDirectory(paths_.bundle));
    Bundle("1.2.3", "first executable");
  }
  void Bundle(const std::string& version, const std::string& contents) {
    ASSERT_TRUE(base::WriteFile(paths_.bundle.AppendASCII(kName), contents));
    base::DictValue metadata;
    metadata.Set("version", version);
    metadata.Set("platform", kPlatform);
    metadata.Set("sha256",
                  base::HexEncodeLower(crypto::SHA256HashString(contents)));
    ASSERT_TRUE(base::WriteFile(paths_.bundle.AppendASCII("manifest.json"),
                                *base::WriteJson(metadata)));
  }
  base::ScopedTempDir root_;
  CliInstaller::Paths paths_;
};

TEST_F(CliInstallerTest, InstallsAndUpgradesOnlyItsOwnExecutable) {
  EXPECT_TRUE(CliInstaller::InstalledVersion(paths_).is_none());
  auto installed = CliInstaller::Install(paths_);
  ASSERT_EQ(installed.FindBool("ok"), true);
  EXPECT_EQ(CliInstaller::InstalledVersion(paths_), base::Value("1.2.3"));
  Bundle("1.2.4-beta.1", "upgraded executable");
  installed = CliInstaller::Install(paths_);
  ASSERT_EQ(installed.FindBool("ok"), true);
  EXPECT_EQ(CliInstaller::InstalledVersion(paths_), base::Value("1.2.4-beta.1"));
  std::string contents;
  ASSERT_TRUE(base::ReadFileToString(paths_.bin.AppendASCII(kName), &contents));
  EXPECT_EQ(contents, "upgraded executable");
}

TEST_F(CliInstallerTest, RefusesAForeignCommandAndLeavesItAlone) {
  ASSERT_TRUE(base::CreateDirectory(paths_.bin));
  const auto destination = paths_.bin.AppendASCII(kName);
  ASSERT_TRUE(base::WriteFile(destination, "another bay command"));
  auto result = CliInstaller::Install(paths_);
  EXPECT_EQ(result.FindBool("ok"), false);
  EXPECT_TRUE(CliInstaller::InstalledVersion(paths_).is_none());
  std::string contents;
  ASSERT_TRUE(base::ReadFileToString(destination, &contents));
  EXPECT_EQ(contents, "another bay command");
}

TEST_F(CliInstallerTest, RejectsTamperedAndUnversionedBundlesBeforeInstalling) {
  ASSERT_TRUE(base::WriteFile(paths_.bundle.AppendASCII(kName), "changed"));
  EXPECT_EQ(CliInstaller::Install(paths_).FindBool("ok"), false);
  EXPECT_FALSE(base::PathExists(paths_.home));
  Bundle("../2.0.0", "new executable");
  EXPECT_EQ(CliInstaller::Install(paths_).FindBool("ok"), false);
  EXPECT_FALSE(base::PathExists(paths_.home));
}

TEST_F(CliInstallerTest, ModifiedInstalledCommandIsNeverOverwritten) {
  ASSERT_EQ(CliInstaller::Install(paths_).FindBool("ok"), true);
  ASSERT_TRUE(base::WriteFile(paths_.bin.AppendASCII(kName), "foreign replacement"));
  EXPECT_TRUE(CliInstaller::InstalledVersion(paths_).is_none());
  Bundle("2.0.0", "new executable");
  EXPECT_EQ(CliInstaller::Install(paths_).FindBool("ok"), false);
}

TEST_F(CliInstallerTest, MissingIsolationOverridesCannotInstallInWorkingDirectory) {
  paths_.home = {};
  paths_.bin = {};
  EXPECT_TRUE(CliInstaller::InstalledVersion(paths_).is_none());
  EXPECT_EQ(CliInstaller::Install(paths_).FindBool("ok"), false);
}

TEST_F(CliInstallerTest, InstallationRefreshesEveryLiveWindowSnapshot) {
  content::BrowserTaskEnvironment tasks;
  TestingProfile profile;
  ASSERT_TRUE(base::Move(paths_.bundle,
                         root_.GetPath().AppendASCII("bay-cli")));
  base::ScopedPathOverride executable(base::DIR_EXE, root_.GetPath());
  base::ScopedEnvironmentVariableOverride isolated("BAY_DATA_DIR",
                                                   root_.GetPath().AsUTF8Unsafe());
  base::ScopedEnvironmentVariableOverride home("BAY_CLI_HOME",
                                               paths_.home.AsUTF8Unsafe());
  base::ScopedEnvironmentVariableOverride bin("BAY_CLI_BIN_DIR",
                                              paths_.bin.AsUTF8Unsafe());
  int refreshed = 0;
  CliInstallerService first(HostContext::ForCoordinator(profile),
                             base::DoNothing(), base::DoNothing());
  CliInstallerService second(HostContext::ForCoordinator(profile),
                              base::DoNothing(),
                              base::BindLambdaForTesting([&] { ++refreshed; }));
  base::test::TestFuture<void> first_ready;
  base::test::TestFuture<void> second_ready;
  first.Prepare(first_ready.GetCallback());
  second.Prepare(second_ready.GetCallback());
  ASSERT_TRUE(first_ready.Wait());
  ASSERT_TRUE(second_ready.Wait());
  EXPECT_TRUE(second.Snapshot().Find("installedVersion")->is_none());
  base::test::TestFuture<const std::string&> completed;
  CliInstallerService::Response response = completed.GetCallback();
  ASSERT_TRUE(first.Dispatch("BayCli", "install", base::ListValue(), response));
  ASSERT_TRUE(completed.Wait());
  tasks.RunUntilIdle();
  EXPECT_EQ(refreshed, 1);
  EXPECT_EQ(second.Snapshot().Find("installedVersion")->GetString(), "1.2.3");
}

#if !BUILDFLAG(IS_WIN)
TEST_F(CliInstallerTest, RefusesForeignSymlinkAtTheCommandPath) {
  ASSERT_TRUE(base::CreateDirectory(paths_.bin));
  auto target = root_.GetPath().AppendASCII("foreign");
  ASSERT_TRUE(base::WriteFile(target, "other executable"));
  ASSERT_TRUE(base::CreateSymbolicLink(target, paths_.bin.AppendASCII(kName)));
  EXPECT_EQ(CliInstaller::Install(paths_).FindBool("ok"), false);
  EXPECT_TRUE(base::IsLink(paths_.bin.AppendASCII(kName)));
}
#endif
}  // namespace
}  // namespace bay
