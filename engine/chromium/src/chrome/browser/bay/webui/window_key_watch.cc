// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/window_key_watch.h"

#include <utility>

#include "ui/aura/env.h"
#include "ui/events/event.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/views/widget/widget.h"

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
}  // namespace

int HeldSwitcherModifiers(bool pressed, int key_code, int flags) {
  int held = flags & kHolds;
  if (pressed)
    return held;
  if (IsControl(key_code))
    held &= ~ui::EF_CONTROL_DOWN;
  else if (IsAlt(key_code))
    held &= ~ui::EF_ALT_DOWN;
  else if (IsCommand(key_code))
    held &= ~ui::EF_COMMAND_DOWN;
  return held;
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

// static
WindowKeyWatch& WindowKeyWatch::Get() {
  static base::NoDestructor<WindowKeyWatch> watch;
  return *watch;
}
WindowKeyWatch::WindowKeyWatch() = default;
WindowKeyWatch::~WindowKeyWatch() = default;

void WindowKeyWatch::Install() {
  if (installed_)
    return;
  installed_ = true;
  aura::Env::GetInstance()->AddPreTargetHandler(this);
}
void WindowKeyWatch::SetAltTapHandler(base::RepeatingClosure handler) {
  alt_tap_ = std::move(handler);
}
void WindowKeyWatch::StartSwitcher(const void* owner,
                                   views::Widget* window,
                                   Sink sink) {
  StopSwitcher(owner_);
  owner_ = owner;
  sink_ = std::move(sink);
  window_ = window;
  if (window_)
    window_->AddObserver(this);
  if (!held_)
    Send("controlReleased");
}
void WindowKeyWatch::StopSwitcher(const void* owner) {
  if (owner != owner_)
    return;
  if (window_)
    window_->RemoveObserver(this);
  window_ = nullptr;
  owner_ = nullptr;
  sink_.Reset();
}
void WindowKeyWatch::Send(const char* type, const char* key) {
  if (!sink_)
    return;
  base::DictValue event;
  event.Set("type", type);
  if (key)
    event.Set("key", key);
  sink_.Run(std::move(event));
}
void WindowKeyWatch::OnKeyEvent(ui::KeyEvent* event) {
  const bool pressed = event->type() == ui::EventType::kKeyPressed;
  const int key = event->key_code();
  held_ = HeldSwitcherModifiers(pressed, key, event->flags());
  if (alt_.OnKey(pressed, key) && alt_tap_)
    alt_tap_.Run();
  if (!sink_)
    return;
  if (!held_) {
    Send("controlReleased");
    return;
  }
  if (!pressed)
    return;
  const SwitcherKey action = ClassifySwitcherKey(key);
  if (action == SwitcherKey::kPassThrough)
    return;
  event->StopPropagation();
  if (action == SwitcherKey::kEscape)
    Send("switcherKey", "escape");
  else if (action == SwitcherKey::kNext)
    Send("switcherKey", "next");
  else if (action == SwitcherKey::kPrevious)
    Send("switcherKey", "previous");
}
void WindowKeyWatch::OnMouseEvent(ui::MouseEvent* event) {
  if (event->type() == ui::EventType::kMousePressed)
    alt_.OnMouse();
  if (event->type() == ui::EventType::kMouseReleased)
    Send("switcherMouseUp");
}
void WindowKeyWatch::OnWidgetActivationChanged(views::Widget* widget,
                                               bool active) {
  // Leaving the app commits, as on macOS: Ctrl's release may never come here.
  if (!active)
    Send("controlReleased");
}
void WindowKeyWatch::OnWidgetDestroying(views::Widget* widget) {
  StopSwitcher(owner_);
}
}  // namespace bay
