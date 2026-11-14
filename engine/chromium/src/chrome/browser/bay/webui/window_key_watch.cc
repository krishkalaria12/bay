// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/window_key_watch.h"

#include <utility>

#include "ui/aura/env.h"
#include "ui/events/event.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/views/widget/widget.h"

namespace bay {
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
void WindowKeyWatch::SetAltHoldHandlers(base::RepeatingCallback<bool()> held,
                                        base::RepeatingClosure released) {
  alt_held_ = std::move(held);
  alt_released_ = std::move(released);
}
void WindowKeyWatch::AppResigned() {
  ApplyAltHold(alt_hold_.OnLeft());
}
void WindowKeyWatch::ApplyAltHold(AltHold::Action action) {
  switch (action) {
    case AltHold::Action::kNone:
      return;
    case AltHold::Action::kStart:
      alt_hold_timer_.Start(FROM_HERE, AltHold::kDelay, this,
                            &WindowKeyWatch::AltHoldElapsed);
      return;
    case AltHold::Action::kCancel:
      alt_hold_timer_.Stop();
      return;
    case AltHold::Action::kRelease:
      alt_hold_timer_.Stop();
      if (alt_released_)
        alt_released_.Run();
      return;
  }
}
void WindowKeyWatch::AltHoldElapsed() {
  if (alt_held_ && alt_held_.Run())
    alt_hold_.Shown();
  else
    ApplyAltHold(alt_hold_.OnLeft());
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
  // Letting go of a hold puts the sidebar back: it isn't also a tap.
  const bool held_out = alt_hold_.shown();
  if (alt_.OnKey(pressed, key) && alt_tap_ && !held_out)
    alt_tap_.Run();
  ApplyAltHold(alt_hold_.OnKey(pressed, key, event->flags(),
                               base::TimeTicks::Now()));
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
  if (event->type() == ui::EventType::kMousePressed) {
    alt_.OnMouse();
    ApplyAltHold(alt_hold_.OnMouse());
  }
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
