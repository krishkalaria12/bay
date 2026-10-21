// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/pip/nn_pip_platform.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/test/scoped_path_override.h"
#include "chrome/common/chrome_paths.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace {

class PictureInPictureBoundsTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(directory_.CreateUniqueTempDir());
    override_.emplace(chrome::DIR_USER_DATA, directory_.GetPath());
  }

  base::FilePath File() const {
    return directory_.GetPath().AppendASCII("BayPictureInPicture.json");
  }

  base::ScopedTempDir directory_;
  std::optional<base::ScopedPathOverride> override_;
};

TEST_F(PictureInPictureBoundsTest, MissingFileHasNoSavedBounds) {
  EXPECT_FALSE(LoadBayPictureInPictureBounds());
}

TEST_F(PictureInPictureBoundsTest, RoundTripsSizeAndNegativeDisplayOrigin) {
  const gfx::Rect bounds(-1920, 24, 480, 270);
  SaveBayPictureInPictureBounds(bounds);
  EXPECT_EQ(bounds, LoadBayPictureInPictureBounds());
}

TEST_F(PictureInPictureBoundsTest, RejectsMalformedAndUnusableBounds) {
  for (const char* json : {
           "not json",
           "[]",
           R"({"x":0,"y":0,"width":480})",
           R"({"x":0,"y":0,"width":0,"height":270})",
           R"({"x":0,"y":0,"width":480,"height":-1})",
           R"({"x":false,"y":0,"width":480,"height":270})",
           R"({"x":0,"y":0,"width":1.5,"height":270})",
           R"({"x":2147483648,"y":0,"width":480,"height":270})",
       }) {
    SCOPED_TRACE(json);
    ASSERT_TRUE(base::WriteFile(File(), json));
    EXPECT_FALSE(LoadBayPictureInPictureBounds());
  }
}

TEST_F(PictureInPictureBoundsTest, EmptySavePreservesLastUsableBounds) {
  const gfx::Rect bounds(12, 34, 480, 270);
  SaveBayPictureInPictureBounds(bounds);
  SaveBayPictureInPictureBounds(gfx::Rect());
  EXPECT_EQ(bounds, LoadBayPictureInPictureBounds());
}

}  // namespace
