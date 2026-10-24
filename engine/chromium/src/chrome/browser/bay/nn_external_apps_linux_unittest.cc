// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_external_apps_platform.h"

#include <cstdlib>

#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/task/thread_pool.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "base/uuid.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {

class ExternalAppsLinuxTest : public testing::Test {
 protected:
  base::DictValue Lookup(const std::string& scheme) {
    base::test::TestFuture<base::DictValue> result;
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock()},
        base::BindOnce(&AppForScheme, scheme), result.GetCallback());
    return result.Take();
  }

  base::test::TaskEnvironment tasks_;
};

TEST_F(ExternalAppsLinuxTest, UnregisteredSchemeHasNullMetadata) {
  const auto result = Lookup("bay-test-" +
                             base::Uuid::GenerateRandomV4().AsLowercaseString());
  ASSERT_TRUE(result.Find("app"));
  EXPECT_TRUE(result.Find("app")->is_none());
  ASSERT_TRUE(result.Find("icon"));
  EXPECT_TRUE(result.Find("icon")->is_none());
}

TEST_F(ExternalAppsLinuxTest, MalformedSchemesDoNotQueryAnotherHandler) {
  for (const auto& scheme : {std::string(), std::string("https://example.com"),
                            std::string("1invalid"), std::string("https\0evil", 10)}) {
    SCOPED_TRACE(scheme);
    const auto result = Lookup(scheme);
    ASSERT_TRUE(result.Find("app"));
    EXPECT_TRUE(result.Find("app")->is_none());
    ASSERT_TRUE(result.Find("icon"));
    EXPECT_TRUE(result.Find("icon")->is_none());
  }
}

TEST_F(ExternalAppsLinuxTest, FtpAssociationUsesTheRegisteredDisplayName) {
  // Re-exec keeps GIO's process-wide caches and XDG overrides away from the
  // other cases and the user's actual desktop associations.
  GTEST_FLAG_SET(death_test_style, "threadsafe");
  ASSERT_EXIT(
      {
        const int status = [&] {
          base::ScopedTempDir fixture;
          if (!fixture.CreateUniqueTempDir())
            return 1;
          const auto data = fixture.GetPath().AppendASCII("data");
          const auto config = fixture.GetPath().AppendASCII("config");
          const auto applications = data.AppendASCII("applications");
          if (!base::CreateDirectory(applications) ||
              !base::CreateDirectory(config) ||
              !base::WriteFile(applications.AppendASCII("bay-protocol-test.desktop"),
                               "[Desktop Entry]\nType=Application\n"
                               "Name=Bay protocol fixture\nExec=/bin/true %u\n"
                               "MimeType=x-scheme-handler/ftp;\n") ||
              !base::WriteFile(config.AppendASCII("mimeapps.list"),
                               "[Default Applications]\n"
                               "x-scheme-handler/ftp=bay-protocol-test.desktop;\n"))
            return 1;
          auto environment = base::Environment::Create();
          if (!environment->SetVar("XDG_DATA_HOME", data.AsUTF8Unsafe()) ||
              !environment->SetVar("XDG_DATA_DIRS", data.AsUTF8Unsafe()) ||
              !environment->SetVar("XDG_CONFIG_HOME", config.AsUTF8Unsafe()) ||
              !environment->SetVar("XDG_CONFIG_DIRS", config.AsUTF8Unsafe()))
            return 1;
          const auto result = Lookup("ftp");
          const auto* app = result.FindString("app");
          return app && *app == "Bay protocol fixture" ? 0 : 1;
        }();
        std::exit(status);
      },
      testing::ExitedWithCode(0), "");
}

}  // namespace
}  // namespace bay
