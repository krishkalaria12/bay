// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_swipe_events.h"

#include <string>

#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {

std::string Phase(const std::optional<SwipeTracker::Event>& event) {
  return event ? event->phase : "";
}

// Unused, mostly horizontal travel, past the start distance.
std::optional<SwipeTracker::Event> Move(SwipeTracker& tracker,
                                        float dx,
                                        float dy = 0,
                                        bool consumed = false) {
  return tracker.Update(dx, dy, consumed, /*momentum=*/false,
                        /*can_go_back=*/true, /*can_go_forward=*/true);
}

TEST(SwipeTrackerTest, FingersMovingRightGoBackAndReportTheirTravel) {
  SwipeTracker tracker;
  tracker.Begin();
  EXPECT_EQ(Phase(Move(tracker, 5)), "");
  const auto began = Move(tracker, 5);
  ASSERT_EQ(Phase(began), "began");
  EXPECT_TRUE(began->back);
  EXPECT_FLOAT_EQ(began->distance, 10);
  const auto changed = Move(tracker, 30, 6);
  ASSERT_EQ(Phase(changed), "changed");
  EXPECT_FLOAT_EQ(changed->distance, 40);
  EXPECT_FLOAT_EQ(changed->dy, 6);
  const auto ended = tracker.End();
  ASSERT_EQ(Phase(ended), "ended");
  EXPECT_FLOAT_EQ(ended->distance, 40);
}

TEST(SwipeTrackerTest, FingersMovingLeftGoForward) {
  SwipeTracker tracker;
  tracker.Begin();
  const auto began = Move(tracker, -12);
  ASSERT_EQ(Phase(began), "began");
  EXPECT_FALSE(began->back);
  EXPECT_FLOAT_EQ(began->distance, 12);
}

TEST(SwipeTrackerTest, WhatThePageScrollsIsThePagesUntilTheFingersLift) {
  SwipeTracker tracker;
  tracker.Begin();
  EXPECT_EQ(Phase(Move(tracker, 4, 0, /*consumed=*/true)), "");
  EXPECT_EQ(Phase(Move(tracker, 40)), "");
  EXPECT_EQ(Phase(tracker.End()), "");
  tracker.Begin();
  EXPECT_EQ(Phase(Move(tracker, 12)), "began");
}

TEST(SwipeTrackerTest, AVerticalScrollNeverSwipes) {
  SwipeTracker tracker;
  tracker.Begin();
  EXPECT_EQ(Phase(Move(tracker, 1, 6)), "");
  EXPECT_EQ(Phase(Move(tracker, 40)), "");
}

TEST(SwipeTrackerTest, NoHistoryThatWayNoSwipe) {
  SwipeTracker tracker;
  tracker.Begin();
  EXPECT_FALSE(tracker.Update(12, 0, false, false, /*can_go_back=*/false,
                              /*can_go_forward=*/true));
  EXPECT_FALSE(tracker.Update(12, 0, false, false, true, true));
}

TEST(SwipeTrackerTest, TheFlingEndsTheSwipeAndIsLeftToThePage) {
  SwipeTracker tracker;
  tracker.Begin();
  ASSERT_EQ(Phase(Move(tracker, 20)), "began");
  EXPECT_EQ(Phase(tracker.Update(30, 0, false, /*momentum=*/true, true, true)),
            "ended");
  EXPECT_FALSE(tracker.Update(30, 0, false, true, true, true));
  EXPECT_FALSE(tracker.End());
}

TEST(SwipeTrackerTest, NothingWithoutABegin) {
  SwipeTracker tracker;
  EXPECT_FALSE(Move(tracker, 40));
  EXPECT_FALSE(tracker.End());
}

}  // namespace
}  // namespace bay
