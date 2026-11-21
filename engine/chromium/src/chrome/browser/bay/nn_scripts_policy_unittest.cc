// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_scripts_policy.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/json/json_writer.h"
#include "base/values.h"
#include "build/build_config.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "testing/gtest/include/gtest/gtest.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace bay {
namespace {

class ScriptsPolicyTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    ASSERT_TRUE(temporary_.CreateUniqueTempDir());
    folder_ = temporary_.GetPath().AppendASCII("Scripts").AppendASCII("extension");
    ASSERT_TRUE(base::CreateDirectory(folder_));
    ASSERT_TRUE(base::WriteFile(folder_.AppendASCII("script.js"), "void 0;"));
    manifest_ = base::DictValue()
        .Set("name", "Bay Scripts")
        .Set("version", "1.0")
        .Set("manifest_version", 3)
        .Set("content_scripts",
             base::ListValue().Append(
                 base::DictValue()
                     .Set("matches", base::ListValue().Append("https://example.com/*"))
                     .Set("js", base::ListValue().Append("script.js"))));
    WriteManifest();
  }

  void WriteManifest() {
    ASSERT_TRUE(base::WriteFile(folder_.AppendASCII("manifest.json"),
                               base::WriteJson(manifest_).value()));
  }

  base::ScopedTempDir temporary_;
  base::FilePath folder_;
  base::DictValue manifest_;
};

TEST_F(ScriptsPolicyTest, AcceptsContentScriptsAndRejectsPermissionCapabilities) {
  EXPECT_FALSE(ValidateScriptsFolder(folder_));
  manifest_.Set("permissions", base::ListValue().Append("tabs"));
  WriteManifest();
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
  manifest_.Remove("permissions");
  manifest_.Set("background", base::DictValue().Set("service_worker", "script.js"));
  WriteManifest();
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
}

TEST_F(ScriptsPolicyTest, RejectsEmptyListsAndTraversal) {
  manifest_.Set("content_scripts", base::ListValue());
  WriteManifest();
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
  ASSERT_TRUE(base::WriteFile(folder_.DirName().AppendASCII("outside.js"), "void 0;"));
  manifest_.Set("content_scripts",
                base::ListValue().Append(
                    base::DictValue()
                        .Set("matches", base::ListValue().Append("https://example.com/*"))
                        .Set("js", base::ListValue().Append("../outside.js"))));
  WriteManifest();
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
}

TEST_F(ScriptsPolicyTest, RefusesScriptHardLinks) {
  const auto script = folder_.AppendASCII("script.js");
  const auto alias = temporary_.GetPath().AppendASCII("alias.js");
#if BUILDFLAG(IS_WIN)
  ASSERT_TRUE(CreateHardLinkW(alias.value().c_str(), script.value().c_str(), nullptr));
#else
  ASSERT_EQ(link(script.value().c_str(), alias.value().c_str()), 0);
#endif
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
}

TEST_F(ScriptsPolicyTest, RefusesManifestHardLinks) {
  const auto manifest = folder_.AppendASCII("manifest.json");
  const auto alias = temporary_.GetPath().AppendASCII("alias.json");
#if BUILDFLAG(IS_WIN)
  ASSERT_TRUE(CreateHardLinkW(alias.value().c_str(), manifest.value().c_str(), nullptr));
#else
  ASSERT_EQ(link(manifest.value().c_str(), alias.value().c_str()), 0);
#endif
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
}

#if !BUILDFLAG(IS_WIN)
TEST_F(ScriptsPolicyTest, RefusesSymbolicLinksAndSpecialFilesBeforeLoading) {
  const auto script = folder_.AppendASCII("script.js");
  const auto outside = temporary_.GetPath().AppendASCII("outside.js");
  ASSERT_TRUE(base::Move(script, outside));
  ASSERT_TRUE(base::CreateSymbolicLink(outside, script));
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
  ASSERT_TRUE(base::DeleteFile(script));
  ASSERT_EQ(mkfifo(script.value().c_str(), 0600), 0);
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
  ASSERT_TRUE(base::DeleteFile(script));
  ASSERT_TRUE(base::Move(outside, script));
  const auto manifest = folder_.AppendASCII("manifest.json");
  const auto elsewhere = temporary_.GetPath().AppendASCII("elsewhere.json");
  ASSERT_TRUE(base::Move(manifest, elsewhere));
  ASSERT_TRUE(base::CreateSymbolicLink(elsewhere, manifest));
  EXPECT_TRUE(ValidateScriptsFolder(folder_));
}
#endif

}  // namespace
}  // namespace bay
