// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/clear_specks.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkColor.h"

namespace bay {
namespace {
// Two rows of 40×10 points at 2× on white, the first with a black mark.
SkBitmap Rows() {
  SkBitmap bitmap;
  bitmap.allocN32Pixels(80, 40);
  bitmap.eraseColor(SK_ColorWHITE);
  bitmap.erase(SK_ColorBLACK, SkIRect::MakeXYWH(20, 6, 8, 8));
  return bitmap;
}

TEST(ClearSpecksTest, OnlyARowsInkBecomesSpecksInDocumentPoints) {
  const auto specks =
      RowSpecks(Rows(), gfx::RectF(100, 50, 40, 20), 2,
                {gfx::RectF(100, 50, 40, 10), gfx::RectF(100, 60, 40, 10)});
  ASSERT_EQ(specks.size(), 2u);
  const auto& first = specks[0].GetList();
  // Every second pixel of the 8×8 mark, a point apart.
  ASSERT_EQ(first.size(), 16u * 6);
  for (size_t i = 0; i < first.size(); i += 6) {
    EXPECT_GE(first[i].GetDouble(), 110);
    EXPECT_LT(first[i].GetDouble(), 114);
    EXPECT_GE(first[i + 1].GetDouble(), 53);
    EXPECT_LT(first[i + 1].GetDouble(), 57);
    EXPECT_EQ(first[i + 2].GetInt(), 0);
    EXPECT_EQ(first[i + 5].GetInt(), 255);
  }
  EXPECT_TRUE(specks[1].GetList().empty());
}
TEST(ClearSpecksTest, ABusyRowKeepsOnlyItsShareOfTheBudget) {
  SkBitmap bitmap;
  bitmap.allocN32Pixels(400, 400);
  bitmap.eraseColor(SK_ColorWHITE);
  // Ink everywhere but the edges the background is read from.
  bitmap.erase(SK_ColorBLACK, SkIRect::MakeXYWH(4, 4, 392, 392));
  const auto specks = RowSpecks(bitmap, gfx::RectF(0, 0, 400, 400), 1,
                                {gfx::RectF(0, 0, 400, 400)});
  ASSERT_EQ(specks.size(), 1u);
  EXPECT_EQ(specks[0].GetList().size(), 700u * 6);
}
TEST(ClearSpecksTest, RowsOutsideTheCopyOrTooThinGiveNothing) {
  const auto specks =
      RowSpecks(Rows(), gfx::RectF(100, 50, 40, 20), 2,
                {gfx::RectF(0, 0, 40, 10), gfx::RectF(100, 50, 40, 1)});
  ASSERT_EQ(specks.size(), 2u);
  EXPECT_TRUE(specks[0].GetList().empty());
  EXPECT_TRUE(specks[1].GetList().empty());
  EXPECT_TRUE(RowSpecks(Rows(), gfx::RectF(), 0, {gfx::RectF()}).empty());
}
}  // namespace
}  // namespace bay
