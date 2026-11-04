// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/window_key_watch.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"

namespace bay {
namespace {
TEST(WindowKeyWatchTest, ARelasedModifierCountsAsUpEvenInItsOwnFlags) {
  const int ctrl = ui::EF_CONTROL_DOWN;
  EXPECT_EQ(HeldSwitcherModifiers(true, ui::VKEY_TAB, ctrl), ctrl);
  EXPECT_EQ(HeldSwitcherModifiers(false, ui::VKEY_CONTROL, ctrl), 0);
  EXPECT_EQ(HeldSwitcherModifiers(false, ui::VKEY_RCONTROL, ctrl), 0);
  EXPECT_EQ(HeldSwitcherModifiers(false, ui::VKEY_CONTROL, 0), 0);
  EXPECT_EQ(HeldSwitcherModifiers(false, ui::VKEY_TAB, ctrl), ctrl);
  EXPECT_EQ(HeldSwitcherModifiers(false, ui::VKEY_MENU,
                                  ctrl | ui::EF_ALT_DOWN),
            ctrl);
}
TEST(WindowKeyWatchTest, ShiftDoesNotHoldTheSwitcherOpen) {
  EXPECT_EQ(HeldSwitcherModifiers(true, ui::VKEY_TAB, ui::EF_SHIFT_DOWN), 0);
}
TEST(WindowKeyWatchTest, TheSwitcherTakesKeysAsMacOSDoes) {
  EXPECT_EQ(ClassifySwitcherKey(ui::VKEY_RIGHT), SwitcherKey::kNext);
  EXPECT_EQ(ClassifySwitcherKey(ui::VKEY_LEFT), SwitcherKey::kPrevious);
  EXPECT_EQ(ClassifySwitcherKey(ui::VKEY_ESCAPE), SwitcherKey::kEscape);
  EXPECT_EQ(ClassifySwitcherKey(ui::VKEY_TAB), SwitcherKey::kPassThrough);
  EXPECT_EQ(ClassifySwitcherKey(ui::VKEY_SHIFT), SwitcherKey::kPassThrough);
  EXPECT_EQ(ClassifySwitcherKey(ui::VKEY_A), SwitcherKey::kTaken);
  EXPECT_EQ(ClassifySwitcherKey(ui::VKEY_RETURN), SwitcherKey::kTaken);
}
TEST(WindowKeyWatchTest, AltTapIsAltAloneWithNothingBetween) {
  AltTap tap;
  EXPECT_FALSE(tap.OnKey(true, ui::VKEY_MENU));
  EXPECT_TRUE(tap.OnKey(false, ui::VKEY_MENU));
  // Auto-repeat of a held Alt is still a tap.
  EXPECT_FALSE(tap.OnKey(true, ui::VKEY_MENU));
  EXPECT_FALSE(tap.OnKey(true, ui::VKEY_MENU));
  EXPECT_TRUE(tap.OnKey(false, ui::VKEY_MENU));
  // Alt+Left, Alt and a click, or a lone release, aren't.
  EXPECT_FALSE(tap.OnKey(true, ui::VKEY_MENU));
  EXPECT_FALSE(tap.OnKey(true, ui::VKEY_LEFT));
  EXPECT_FALSE(tap.OnKey(false, ui::VKEY_LEFT));
  EXPECT_FALSE(tap.OnKey(false, ui::VKEY_MENU));
  EXPECT_FALSE(tap.OnKey(true, ui::VKEY_MENU));
  tap.OnMouse();
  EXPECT_FALSE(tap.OnKey(false, ui::VKEY_MENU));
  EXPECT_FALSE(tap.OnKey(false, ui::VKEY_MENU));
}
}  // namespace
}  // namespace bay
