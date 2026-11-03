// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shortcut_recorder.h"

#include <string>

#include "base/json/json_writer.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/events/keycodes/keyboard_codes.h"

namespace bay {
namespace {
std::string Recorded(int key_code,
                     bool ctrl = false,
                     bool shift = false,
                     bool alt = false) {
  auto result = RecordedShortcutFor(key_code, ctrl, shift, alt, false);
  return result ? base::WriteJson(*result).value_or("") : "waiting";
}

TEST(ShortcutRecorderTest, LettersAndModifiersUseTheMenusVocabulary) {
  EXPECT_EQ(Recorded(ui::VKEY_T, true),
            R"({"key":"t","keyCode":84,"modifiers":["command"]})");
  EXPECT_EQ(
      Recorded(ui::VKEY_K, true, true, true),
      R"({"key":"k","keyCode":75,"modifiers":["option","shift","command"]})");
  EXPECT_EQ(Recorded(ui::VKEY_7, false, true),
            R"({"key":"7","keyCode":55,"modifiers":["shift"]})");
}
TEST(ShortcutRecorderTest, SpecialKeysUseAppKitsCharacters) {
  const auto key = [](int key_code) {
    auto result = RecordedShortcutFor(key_code, true, false, false, false);
    return std::string(*result->GetDict().FindString("key"));
  };
  EXPECT_EQ(key(ui::VKEY_UP), "");
  EXPECT_EQ(key(ui::VKEY_RIGHT), "");
  EXPECT_EQ(key(ui::VKEY_F1), "");
  EXPECT_EQ(key(ui::VKEY_F12), "");
  EXPECT_EQ(key(ui::VKEY_DELETE), "");
  EXPECT_EQ(key(ui::VKEY_PRIOR), "");
  EXPECT_EQ(key(ui::VKEY_TAB), "\t");
  EXPECT_EQ(key(ui::VKEY_RETURN), "\r");
  EXPECT_EQ(key(ui::VKEY_BACK), "\x7f");
  EXPECT_EQ(key(ui::VKEY_OEM_PLUS), "=");
  EXPECT_EQ(key(ui::VKEY_OEM_5), "\\");
}
TEST(ShortcutRecorderTest, BareEscapeCancelsAndWithAModifierIsAKey) {
  EXPECT_EQ(Recorded(ui::VKEY_ESCAPE), "null");
  EXPECT_NE(Recorded(ui::VKEY_ESCAPE, true), "null");
  EXPECT_NE(Recorded(ui::VKEY_ESCAPE, true), "waiting");
}
TEST(ShortcutRecorderTest, ModifiersAloneAndSuperKeepWaiting) {
  for (int key_code : {ui::VKEY_SHIFT, ui::VKEY_CONTROL, ui::VKEY_MENU,
                       ui::VKEY_LWIN, ui::VKEY_CAPITAL, ui::VKEY_F24})
    EXPECT_EQ(Recorded(key_code, true), "waiting") << key_code;
  EXPECT_FALSE(RecordedShortcutFor(ui::VKEY_T, true, false, false, true));
  EXPECT_FALSE(RecordedShortcutFor(ui::VKEY_ESCAPE, false, false, false, true));
}
}  // namespace
}  // namespace bay
