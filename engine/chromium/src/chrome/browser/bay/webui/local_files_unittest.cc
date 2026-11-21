// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/local_files.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "build/build_config.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
class LocalFileGrantsTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(temp_.CreateUniqueTempDir());
    root_ = base::MakeAbsoluteFilePath(temp_.GetPath()).AppendASCII("Notes");
    ASSERT_TRUE(base::CreateDirectory(root_.AppendASCII("Drafts")));
    ASSERT_TRUE(base::WriteFile(root_.AppendASCII("b.pdf"), "pdf"));
    ASSERT_TRUE(base::WriteFile(root_.AppendASCII("a.txt"), "txt"));
    ASSERT_TRUE(base::WriteFile(root_.AppendASCII(".hidden"), "x"));
    ASSERT_TRUE(base::WriteFile(temp_.GetPath().AppendASCII("secret"), "x"));
  }
  base::FilePath Store() { return temp_.GetPath().AppendASCII("grants.json"); }
  std::string Root() { return root_.AsUTF8Unsafe(); }
  base::ScopedTempDir temp_;
  base::FilePath root_;
};

TEST_F(LocalFileGrantsTest, NothingWithoutAGrant) {
  LocalFileGrants grants(Store());
  EXPECT_EQ(*grants.Inspect(Root(), "").FindString("status"), "inaccessible");
  EXPECT_EQ(*grants.Inspect("/no/such/place", "").FindString("status"),
            "missing");
  EXPECT_TRUE(grants.List(Root(), "").FindList("entries")->empty());
}
TEST_F(LocalFileGrantsTest, AGrantedFolderListsFoldersFirstWithoutHiddenFiles) {
  LocalFileGrants grants(Store());
  const auto pin = grants.Grant(root_, std::nullopt);
  ASSERT_TRUE(pin);
  EXPECT_EQ(*pin->FindString("kind"), "folder");
  EXPECT_EQ(*pin->FindString("name"), "Notes");
  const auto listing = grants.List(Root(), "");
  const auto& entries = *listing.FindList("entries");
  ASSERT_EQ(entries.size(), 3u);
  EXPECT_EQ(*entries[0].GetDict().FindString("name"), "Drafts");
  EXPECT_EQ(*entries[1].GetDict().FindString("name"), "a.txt");
  EXPECT_EQ(*entries[2].GetDict().FindString("relativePath"), "b.pdf");
  const auto pdf = grants.Inspect(Root(), "b.pdf");
  EXPECT_EQ(*pdf.FindString("status"), "available");
  EXPECT_EQ(pdf.FindBool("browserReadable"), true);
  EXPECT_EQ(grants.Inspect(Root(), "a.txt").FindBool("browserReadable"),
            false);
}
TEST_F(LocalFileGrantsTest, NeverReachesOutsideTheGrant) {
  LocalFileGrants grants(Store());
  ASSERT_TRUE(grants.Grant(root_, std::nullopt));
  for (const char* relative : {"../secret", "Drafts/../../secret", "/etc"})
    EXPECT_FALSE(grants.Authorized(Root(), relative)) << relative;
#if BUILDFLAG(IS_POSIX)
  ASSERT_TRUE(base::CreateSymbolicLink(temp_.GetPath().AppendASCII("secret"),
                                       root_.AppendASCII("link")));
  EXPECT_FALSE(grants.Authorized(Root(), "link"));
#endif
}
TEST_F(LocalFileGrantsTest, GrantsLastAndAnAliasKeepsAPinValid) {
  {
    LocalFileGrants grants(Store());
    ASSERT_TRUE(grants.Grant(root_.AppendASCII("a.txt"), "/old/place.txt"));
  }
  LocalFileGrants reloaded(Store());
  EXPECT_EQ(*reloaded.Inspect("/old/place.txt", "").FindString("status"),
            "available");
  EXPECT_FALSE(reloaded.Grant(root_.AppendASCII("missing"), std::nullopt));
#if BUILDFLAG(IS_POSIX)
  int mode = 0;
  ASSERT_TRUE(base::GetPosixFilePermissions(Store(), &mode));
  EXPECT_EQ(mode, 0600);
#endif
}
}  // namespace
}  // namespace bay
