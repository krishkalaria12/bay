// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/window_placement.h"

#include <limits>

#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
TEST(WindowPlacementTest, CompositorPlacementDropsLegacyOrigin) {
  auto options =
      base::DictValue()
          .Set("frame",
               base::ListValue().Append(-1200).Append(50).Append(960).Append(
                   720))
          .Set("maximized", true);
  WindowPlacement placement;
  EXPECT_TRUE(ParseWindowPlacement(options, false, placement).empty());
  EXPECT_FALSE(placement.frame);
  EXPECT_EQ(placement.size, gfx::Size(960, 720));
  EXPECT_EQ(placement.maximized, true);

  options.Set("size", base::ListValue().Append(800).Append(600));
  EXPECT_TRUE(ParseWindowPlacement(options, false, placement).empty());
  EXPECT_FALSE(placement.frame);
  EXPECT_EQ(placement.size, gfx::Size(800, 600));
}

TEST(WindowPlacementTest, GlobalPlacementPreservesFrameAndShowState) {
  WindowPlacement placement;
  EXPECT_TRUE(
      ParseWindowPlacement(
          base::DictValue()
              .Set(
                  "frame",
                  base::ListValue().Append(-1200).Append(50).Append(960).Append(
                      720))
              .Set("size", base::ListValue().Append(800).Append(600))
              .Set("maximized", false),
          true, placement)
          .empty());
  EXPECT_EQ(placement.frame, gfx::Rect(-1200, 50, 960, 720));
  EXPECT_EQ(placement.maximized, false);
}

TEST(WindowPlacementTest, SizeOnlyDoesNotInventAnOrigin) {
  for (const bool global : {false, true}) {
    WindowPlacement placement;
    EXPECT_TRUE(ParseWindowPlacement(
                    base::DictValue().Set(
                        "size", base::ListValue().Append(800.4).Append(600.7)),
                    global, placement)
                    .empty());
    EXPECT_FALSE(placement.frame);
    EXPECT_EQ(placement.size, gfx::Size(800, 601));
    EXPECT_FALSE(placement.maximized);
    EXPECT_TRUE(
        ParseWindowPlacement(base::DictValue(), global, placement).empty());
    EXPECT_FALSE(placement.frame);
    EXPECT_FALSE(placement.size);
  }
}

TEST(WindowPlacementTest, RejectsMalformedSizeEvenWhenFrameIsPresent) {
  for (const bool global : {false, true}) {
    for (const auto& size :
         base::ListValue()
             .Append(base::Value())
             .Append(true)
             .Append("800,600")
             .Append(base::ListValue().Append(800))
             .Append(base::ListValue().Append(800).Append(600).Append(1))
             .Append(base::ListValue().Append(0).Append(600))
             .Append(base::ListValue().Append(800).Append(-1))
             .Append(base::ListValue().Append(32769).Append(600))
             .Append(base::ListValue().Append("800").Append(600))
             .Append(base::ListValue()
                         .Append(std::numeric_limits<double>::infinity())
                         .Append(600))) {
      WindowPlacement placement;
      EXPECT_EQ(
          ParseWindowPlacement(
              base::DictValue()
                  .Set("frame",
                       base::ListValue().Append(0).Append(0).Append(800).Append(
                           600))
                  .Set("size", size.Clone()),
              global, placement),
          "Invalid window size");
    }
  }
}

TEST(WindowPlacementTest, RejectsNonBooleanMaximizedAndMalformedFrame) {
  for (const bool global : {false, true}) {
    for (const auto& value :
         base::ListValue().Append(base::Value()).Append(1).Append("true")) {
      WindowPlacement placement;
      EXPECT_FALSE(ParseWindowPlacement(
                       base::DictValue().Set("maximized", value.Clone()),
                       global, placement)
                       .empty());
    }
    WindowPlacement placement;
    EXPECT_FALSE(ParseWindowPlacement(base::DictValue().Set(
                                          "frame", base::ListValue().Append(1)),
                                      global, placement)
                     .empty());
  }
}

TEST(WindowPlacementTest, NormalDimensionsSurviveShowStateTransitions) {
  RestoredWindowSize restored;
  restored.Seed(gfx::Size(800, 600));
  // Maximize, enter fullscreen, minimize, then return to maximized. None is a
  // normal resize, including a state notification before its bounds arrive.
  for (const auto& bounds : {gfx::Size(1920, 1040), gfx::Size(1920, 1080),
                             gfx::Size(1, 1), gfx::Size(1920, 1040)}) {
    restored.BoundsChanged(bounds, false);
    EXPECT_EQ(restored.size(), gfx::Size(800, 600));
  }
  restored.BoundsChanged(gfx::Size(800, 600), true);
  restored.BoundsChanged(gfx::Size(900, 700), true);
  EXPECT_EQ(restored.size(), gfx::Size(900, 700));
  restored.BoundsChanged(gfx::Size(), true);
  EXPECT_EQ(restored.size(), gfx::Size(900, 700));
}
}  // namespace bay
