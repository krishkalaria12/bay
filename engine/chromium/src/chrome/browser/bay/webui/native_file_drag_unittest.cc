// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/native_file_drag.h"

#include <optional>
#include <string>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/test/test_future.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/local_files.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/base/dragdrop/os_exchange_data.h"

namespace bay {
namespace {
class NativeFileDragTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    ASSERT_TRUE(directory_.CreateUniqueTempDir());
    grants_ = std::make_unique<LocalFileGrants>(
        directory_.GetPath().AppendASCII("grants.json"));
  }
  void TearDown() override {
    grants_.reset();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  base::FilePath File(const char* name) {
    const auto path = directory_.GetPath().AppendASCII(name);
    EXPECT_TRUE(base::WriteFile(path, "a downloaded file"));
    return base::MakeAbsoluteFilePath(path);
  }
  std::optional<base::FilePath> Resolve(
      const base::FilePath& path,
      std::optional<std::string> relative = std::nullopt) {
    return NativeFileDrag::ResolvePath(path.AsUTF8Unsafe(), relative, *grants_);
  }
  base::ScopedTempDir directory_;
  std::unique_ptr<LocalFileGrants> grants_;
};

TEST_F(NativeFileDragTest, DownloadPathsMustBeExistingAbsoluteReadableFiles) {
  const auto file = File("download with spaces.txt");
  EXPECT_EQ(Resolve(file), file);
  EXPECT_FALSE(Resolve(directory_.GetPath().AppendASCII("missing")));
  EXPECT_FALSE(NativeFileDrag::ResolvePath("relative.txt", std::nullopt, *grants_));
  EXPECT_FALSE(NativeFileDrag::ResolvePath("file:///private/file.txt",
                                          std::nullopt, *grants_));
  ASSERT_TRUE(base::DeleteFile(file));
  EXPECT_FALSE(Resolve(file));
}

TEST_F(NativeFileDragTest, PinnedPathsAlwaysRequireTheirActualGrant) {
  const auto file = File("pin.txt");
  EXPECT_FALSE(Resolve(file, ""));
  ASSERT_TRUE(grants_->Grant(file, std::nullopt));
  EXPECT_EQ(Resolve(file, ""), file);
  EXPECT_FALSE(Resolve(file, "other.txt"));
  ASSERT_TRUE(base::DeleteFile(file));
  EXPECT_FALSE(Resolve(file, ""));
}

TEST_F(NativeFileDragTest, GrantedFolderAllowsItsRootAndDescendants) {
  const auto folder = directory_.GetPath().AppendASCII("folder");
  ASSERT_TRUE(base::CreateDirectory(folder));
  const auto file = folder.AppendASCII("child.txt");
  ASSERT_TRUE(base::WriteFile(file, "child"));
  ASSERT_TRUE(grants_->Grant(folder, std::nullopt));
  EXPECT_EQ(Resolve(folder, ""), base::MakeAbsoluteFilePath(folder));
  EXPECT_EQ(Resolve(folder, "child.txt"), base::MakeAbsoluteFilePath(file));
  EXPECT_FALSE(Resolve(folder, "missing.txt"));
  EXPECT_FALSE(Resolve(folder, "../grants.json"));
  EXPECT_FALSE(Resolve(folder, "/grants.json"));
  EXPECT_FALSE(Resolve(folder, "..\\grants.json"));
}

#if BUILDFLAG(IS_POSIX)
TEST_F(NativeFileDragTest, AFolderGrantCannotExportASymlinkOutsideItsRoot) {
  const auto folder = directory_.GetPath().AppendASCII("folder");
  ASSERT_TRUE(base::CreateDirectory(folder));
  const auto outside = File("outside.txt");
  ASSERT_TRUE(base::CreateSymbolicLink(outside, folder.AppendASCII("escape")));
  ASSERT_TRUE(grants_->Grant(folder, std::nullopt));
  EXPECT_FALSE(Resolve(folder, "escape"));
}
#endif

TEST_F(NativeFileDragTest, RejectsNullBytesAndOversizedPathsBeforeFilesystemUse) {
  EXPECT_FALSE(NativeFileDrag::ResolvePath(std::string("valid\0ignored", 13),
                                          std::nullopt, *grants_));
  EXPECT_FALSE(NativeFileDrag::ResolvePath(std::string(32769, 'a'),
                                          std::nullopt, *grants_));
  const auto file = File("pin.txt");
  ASSERT_TRUE(grants_->Grant(file, std::nullopt));
  EXPECT_FALSE(Resolve(file, std::string("\0", 1)));
}

TEST_F(NativeFileDragTest, ExchangeDataContainsAnOsFileListWithoutAWebUrl) {
  const auto file = File("download with spaces.txt");
  auto data = NativeFileDrag::CreateData(file);
  ASSERT_TRUE(data->HasFile());
  const auto files = data->GetFilenames();
  ASSERT_TRUE(files);
  ASSERT_EQ(files->size(), 1u);
  EXPECT_EQ(files->at(0).path, file);
  EXPECT_EQ(files->at(0).display_name, file.BaseName());
  EXPECT_FALSE(data->HasString());
  EXPECT_FALSE(data->HasURL(ui::FilenameToURLPolicy::DO_NOT_CONVERT_FILENAMES));
}

TEST_F(NativeFileDragTest, AWebPageCannotRequestAFileDrag) {
  NavigateAndCommit(GURL("https://example.test/"));
  base::test::TestFuture<NativeFileDrag::Result> result;
  NativeFileDrag::Start(web_contents(), File("secret.txt").AsUTF8Unsafe(),
                         std::nullopt, result.GetCallback());
  ASSERT_TRUE(result.IsReady());
  EXPECT_FALSE(result.Get().started);
  EXPECT_EQ(result.Get().operation, "none");
  EXPECT_FALSE(result.Get().error.empty());
}
}  // namespace
}  // namespace bay
