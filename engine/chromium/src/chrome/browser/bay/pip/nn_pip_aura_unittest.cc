// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/pip/nn_pip_platform.h"

#include <memory>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/test/scoped_path_override.h"
#include "base/test/task_environment.h"
#include "base/threading/thread_restrictions.h"
#include "chrome/common/chrome_paths.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace {

class PictureInPictureBoundsTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(directory_.CreateUniqueTempDir());
    override_.emplace(chrome::DIR_USER_DATA, directory_.GetPath());
    Reload();
  }

  base::FilePath File() const {
    return directory_.GetPath().AppendASCII("BayPictureInPicture.json");
  }

  void Reload() {
#if BUILDFLAG(IS_LINUX)
    store_ = std::make_unique<bay::PictureInPictureBoundsStore>(File(), true);
    task_environment_.RunUntilIdle();
#endif
  }

  std::optional<gfx::Rect> Load() {
#if BUILDFLAG(IS_LINUX)
    return store_->Load();
#else
    return LoadBayPictureInPictureBounds();
#endif
  }

  void Save(const gfx::Rect& bounds) {
#if BUILDFLAG(IS_LINUX)
    store_->Save(bounds);
#else
    SaveBayPictureInPictureBounds(bounds);
#endif
  }

  base::test::TaskEnvironment task_environment_{
      base::test::TaskEnvironment::ThreadPoolExecutionMode::QUEUED};
  base::ScopedTempDir directory_;
  std::optional<base::ScopedPathOverride> override_;
#if BUILDFLAG(IS_LINUX)
  std::unique_ptr<bay::PictureInPictureBoundsStore> store_;
#endif
};

TEST_F(PictureInPictureBoundsTest, MissingFileHasNoSavedBounds) {
  EXPECT_FALSE(Load());
}

TEST_F(PictureInPictureBoundsTest, RoundTripsSizeAndNegativeDisplayOrigin) {
  const gfx::Rect bounds(-1920, 24, 480, 270);
  Save(bounds);
  EXPECT_EQ(bounds, Load());
  task_environment_.RunUntilIdle();
  Reload();
  EXPECT_EQ(bounds, Load());
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
    Reload();
    EXPECT_FALSE(Load());
  }
}

TEST_F(PictureInPictureBoundsTest, EmptySavePreservesLastUsableBounds) {
  const gfx::Rect bounds(12, 34, 480, 270);
  Save(bounds);
  Save(gfx::Rect());
  EXPECT_EQ(bounds, Load());
  task_environment_.RunUntilIdle();
  Reload();
  EXPECT_EQ(bounds, Load());
}

#if BUILDFLAG(IS_LINUX)
TEST_F(PictureInPictureBoundsTest, PreloadAndUiAccessDoNotBlock) {
  const gfx::Rect bounds(12, 34, 480, 270);
  {
    base::ScopedDisallowBlocking disallow_blocking;
    store_ = std::make_unique<bay::PictureInPictureBoundsStore>(File(), true);
    EXPECT_FALSE(Load());
    Save(bounds);
    EXPECT_EQ(bounds, Load());
  }
  task_environment_.RunUntilIdle();
  Reload();
  EXPECT_EQ(bounds, Load());
}

TEST_F(PictureInPictureBoundsTest, RestoresExistingBoundsOnlyAfterPreload) {
  const gfx::Rect bounds(-800, -40, 480, 270);
  Save(bounds);
  task_environment_.RunUntilIdle();
  store_ = std::make_unique<bay::PictureInPictureBoundsStore>(File(), true);
  EXPECT_FALSE(Load());
  task_environment_.RunUntilIdle();
  EXPECT_EQ(bounds, Load());
}

TEST_F(PictureInPictureBoundsTest,
       SaveWinsOverPendingPreloadAndWritesStayOrdered) {
  const gfx::Rect old_bounds(-800, 34, 480, 270);
  Save(old_bounds);
  task_environment_.RunUntilIdle();
  store_ = std::make_unique<bay::PictureInPictureBoundsStore>(File(), true);
  const gfx::Rect latest_bounds(56, 78, 640, 360);
  Save(gfx::Rect(12, 34, 480, 270));
  Save(latest_bounds);
  EXPECT_EQ(latest_bounds, Load());
  task_environment_.RunUntilIdle();
  EXPECT_EQ(latest_bounds, Load());
  Reload();
  EXPECT_EQ(latest_bounds, Load());
}

TEST_F(PictureInPictureBoundsTest,
       WritesSurviveOwnerAndPendingReplyIsCancelled) {
  const gfx::Rect bounds(12, 34, 480, 270);
  store_ = std::make_unique<bay::PictureInPictureBoundsStore>(File(), true);
  Save(bounds);
  store_.reset();
  task_environment_.RunUntilIdle();
  Reload();
  EXPECT_EQ(bounds, Load());
}

TEST_F(PictureInPictureBoundsTest,
       NoGlobalCoordinatesNeitherLoadsNorOverwrites) {
  const gfx::Rect bounds(-800, 34, 480, 270);
  Save(bounds);
  task_environment_.RunUntilIdle();
  std::string before;
  ASSERT_TRUE(base::ReadFileToString(File(), &before));
  store_ = std::make_unique<bay::PictureInPictureBoundsStore>(File(), false);
  EXPECT_FALSE(Load());
  Save(gfx::Rect(0, 0, 640, 360));
  task_environment_.RunUntilIdle();
  EXPECT_FALSE(Load());
  std::string after;
  ASSERT_TRUE(base::ReadFileToString(File(), &after));
  EXPECT_EQ(before, after);
  Reload();
  EXPECT_EQ(bounds, Load());
}

TEST_F(PictureInPictureBoundsTest, NoGlobalCoordinatesDoesNotCreateFile) {
  store_ = std::make_unique<bay::PictureInPictureBoundsStore>(File(), false);
  Save(gfx::Rect(0, 0, 640, 360));
  task_environment_.RunUntilIdle();
  EXPECT_FALSE(Load());
  EXPECT_FALSE(base::PathExists(File()));
}
#endif

TEST(PictureInPictureFadeTest, NullWindowIsSafe) {
  FadeOutBayPictureInPicture(nullptr, base::Milliseconds(100));
  ResetBayPictureInPictureFade(nullptr);
}

}  // namespace
