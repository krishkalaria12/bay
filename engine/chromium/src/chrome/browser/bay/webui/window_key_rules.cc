// Copyright 2026 Bay. Apache-2.0.
// What keys mean, apart from watching them: no window code, so its test links
// on every desktop.
#include "chrome/browser/bay/webui/window_key_rules.h"

#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"

namespace bay {
namespace {
constexpr int kHolds =
    ui::EF_CONTROL_DOWN | ui::EF_ALT_DOWN | ui::EF_COMMAND_DOWN;

bool IsControl(int key) {
  return key == ui::VKEY_CONTROL || key == ui::VKEY_LCONTROL ||
         key == ui::VKEY_RCONTROL;
}
bool IsAlt(int key) {
  return key == ui::VKEY_MENU || key == ui::VKEY_LMENU ||
         key == ui::VKEY_RMENU;
}
bool IsCommand(int key) {
  return key == ui::VKEY_LWIN || key == ui::VKEY_RWIN;
}
bool IsShift(int key) {
  return key == ui::VKEY_SHIFT || key == ui::VKEY_LSHIFT ||
         key == ui::VKEY_RSHIFT;
}
bool IsModifier(int key) {
  return IsControl(key) || IsAlt(key) || IsCommand(key) || IsShift(key);
}
// The modifiers down after this event: its own may still be in its flags.
int ModifiersAfter(bool pressed, int key, int flags) {
  int held = flags & (ui::EF_CONTROL_DOWN | ui::EF_ALT_DOWN |
                      ui::EF_COMMAND_DOWN | ui::EF_SHIFT_DOWN |
                      ui::EF_ALTGR_DOWN);
  if (pressed)
    return held;
  if (IsControl(key))
    held &= ~ui::EF_CONTROL_DOWN;
  else if (IsAlt(key))
    held &= ~ui::EF_ALT_DOWN;
  else if (IsCommand(key))
    held &= ~ui::EF_COMMAND_DOWN;
  else if (IsShift(key))
    held &= ~ui::EF_SHIFT_DOWN;
  return held;
}
}  // namespace

int HeldSwitcherModifiers(bool pressed, int key_code, int flags) {
  return ModifiersAfter(pressed, key_code, flags) & kHolds;
}

SwitcherKey ClassifySwitcherKey(int key_code) {
  switch (key_code) {
    case ui::VKEY_TAB:
    case ui::VKEY_CONTROL:
    case ui::VKEY_LCONTROL:
    case ui::VKEY_RCONTROL:
    case ui::VKEY_SHIFT:
    case ui::VKEY_LSHIFT:
    case ui::VKEY_RSHIFT:
      return SwitcherKey::kPassThrough;
    case ui::VKEY_ESCAPE:
      return SwitcherKey::kEscape;
    case ui::VKEY_RIGHT:
      return SwitcherKey::kNext;
    case ui::VKEY_LEFT:
      return SwitcherKey::kPrevious;
    default:
      return SwitcherKey::kTaken;
  }
}

bool AltTap::OnKey(bool pressed, int key_code) {
  if (pressed) {
    armed_ = IsAlt(key_code);
    return false;
  }
  const bool tapped = armed_ && IsAlt(key_code);
  armed_ = false;
  return tapped;
}

AltHold::Action AltHold::OnLeft() {
  Action action = Action::kNone;
  if (shown_)
    action = Action::kRelease;
  else if (pending_)
    action = Action::kCancel;
  pending_ = false;
  shown_ = false;
  return action;
}
AltHold::Action AltHold::OnKey(bool pressed,
                               int key_code,
                               int flags,
                               base::TimeTicks now) {
  if (!IsModifier(key_code)) {
    if (!pressed)
      return Action::kNone;
    last_key_ = now;
    return OnMouse();
  }
  if (ModifiersAfter(pressed, key_code, flags) != ui::EF_ALT_DOWN)
    return OnLeft();
  const bool typing = !last_key_.is_null() && now - last_key_ < kTypingPause;
  if (pending_ || shown_ || typing)
    return Action::kNone;
  pending_ = true;
  return Action::kStart;
}
AltHold::Action AltHold::OnMouse() {
  if (!pending_)
    return Action::kNone;
  pending_ = false;
  return Action::kCancel;
}
void AltHold::Shown() {
  pending_ = false;
  shown_ = true;
}
}  // namespace bay
