// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/quit_shortcut_linux.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"

namespace bay {
namespace {

TEST(QuitShortcutLinuxTest, CtrlQAloneQuits) {
  EXPECT_TRUE(
      IsLinuxQuitShortcut(ui::Accelerator(ui::VKEY_Q, ui::EF_CONTROL_DOWN)));
  EXPECT_TRUE(IsLinuxQuitShortcut(ui::Accelerator(
      ui::VKEY_Q, ui::EF_CONTROL_DOWN | ui::EF_IS_SYNTHESIZED)));
}

TEST(QuitShortcutLinuxTest, OtherModifiersAndKeysDoNot) {
  for (int modifiers :
       {ui::EF_NONE, ui::EF_SHIFT_DOWN | ui::EF_CONTROL_DOWN,
        ui::EF_ALT_DOWN | ui::EF_CONTROL_DOWN, ui::EF_COMMAND_DOWN,
        ui::EF_COMMAND_DOWN | ui::EF_CONTROL_DOWN}) {
    EXPECT_FALSE(IsLinuxQuitShortcut(ui::Accelerator(ui::VKEY_Q, modifiers)))
        << modifiers;
  }
  EXPECT_FALSE(
      IsLinuxQuitShortcut(ui::Accelerator(ui::VKEY_W, ui::EF_CONTROL_DOWN)));
}

TEST(QuitShortcutLinuxTest, ReleaseAndRepeatDoNot) {
  EXPECT_FALSE(IsLinuxQuitShortcut(ui::Accelerator(
      ui::VKEY_Q, ui::EF_CONTROL_DOWN, ui::Accelerator::KeyState::RELEASED)));
  EXPECT_FALSE(IsLinuxQuitShortcut(
      ui::Accelerator(ui::VKEY_Q, ui::EF_CONTROL_DOWN | ui::EF_IS_REPEAT)));
}

}  // namespace
}  // namespace bay
