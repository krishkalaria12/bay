// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shortcut_recorder.h"

#include <string>

#include "base/strings/utf_string_conversions.h"
#include "ui/events/keycodes/keyboard_codes.h"

namespace bay {
namespace {
std::string FunctionKey(char16_t character) {
  return base::UTF16ToUTF8(std::u16string(1, character));
}
// AppKit's character for the key, which macOS records and Settings' labels
// read. Empty for a key a shortcut can't use.
std::string KeyName(int key_code) {
  if (key_code >= ui::VKEY_A && key_code <= ui::VKEY_Z)
    return std::string(1, static_cast<char>('a' + key_code - ui::VKEY_A));
  if (key_code >= ui::VKEY_0 && key_code <= ui::VKEY_9)
    return std::string(1, static_cast<char>('0' + key_code - ui::VKEY_0));
  if (key_code >= ui::VKEY_F1 && key_code <= ui::VKEY_F20)
    return FunctionKey(static_cast<char16_t>(0xF704 + key_code - ui::VKEY_F1));
  switch (key_code) {
    case ui::VKEY_TAB:
      return "\t";
    case ui::VKEY_RETURN:
      return "\r";
    case ui::VKEY_BACK:
      return "\x7f";
    case ui::VKEY_ESCAPE:
      return "\x1b";
    case ui::VKEY_SPACE:
      return " ";
    case ui::VKEY_UP:
      return FunctionKey(0xF700);
    case ui::VKEY_DOWN:
      return FunctionKey(0xF701);
    case ui::VKEY_LEFT:
      return FunctionKey(0xF702);
    case ui::VKEY_RIGHT:
      return FunctionKey(0xF703);
    case ui::VKEY_DELETE:
      return FunctionKey(0xF728);
    case ui::VKEY_HOME:
      return FunctionKey(0xF729);
    case ui::VKEY_END:
      return FunctionKey(0xF72B);
    case ui::VKEY_PRIOR:
      return FunctionKey(0xF72C);
    case ui::VKEY_NEXT:
      return FunctionKey(0xF72D);
    case ui::VKEY_OEM_1:
      return ";";
    case ui::VKEY_OEM_PLUS:
      return "=";
    case ui::VKEY_OEM_COMMA:
      return ",";
    case ui::VKEY_OEM_MINUS:
      return "-";
    case ui::VKEY_OEM_PERIOD:
      return ".";
    case ui::VKEY_OEM_2:
      return "/";
    case ui::VKEY_OEM_3:
      return "`";
    case ui::VKEY_OEM_4:
      return "[";
    case ui::VKEY_OEM_5:
      return "\\";
    case ui::VKEY_OEM_6:
      return "]";
    case ui::VKEY_OEM_7:
      return "'";
    default:
      return {};
  }
}
}  // namespace

std::optional<base::Value> RecordedShortcutFor(int key_code,
                                               bool ctrl,
                                               bool shift,
                                               bool alt,
                                               bool meta) {
  if (key_code == ui::VKEY_ESCAPE && !ctrl && !shift && !alt && !meta)
    return base::Value();
  // Super belongs to the desktop, and a shortcut has no way to name it. A
  // modifier alone has no key name, so recording waits for the rest.
  const std::string key = KeyName(key_code);
  if (meta || key.empty())
    return std::nullopt;
  base::ListValue modifiers;
  if (alt)
    modifiers.Append("option");
  if (shift)
    modifiers.Append("shift");
  if (ctrl)
    modifiers.Append("command");
  return base::Value(base::DictValue()
                         .Set("key", key)
                         .Set("modifiers", std::move(modifiers))
                         .Set("keyCode", key_code));
}
}  // namespace bay
