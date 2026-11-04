// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_WATCH_H_
#define CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_WATCH_H_

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "ui/events/event_handler.h"
#include "ui/views/widget/widget_observer.h"

namespace views {
class Widget;
}

namespace bay {
// The modifiers that hold the switcher open still down after a key event. A
// released modifier may still be set in its own event's flags.
int HeldSwitcherModifiers(bool pressed, int key_code, int flags);

// What a key does while the Ctrl+Tab switcher is open, as the event monitor in
// ShellModule.swift decides: it moves or cancels, Ctrl+Tab is the window's own
// shortcut, and everything else is taken, so nothing types into a page.
enum class SwitcherKey { kPassThrough, kTaken, kNext, kPrevious, kEscape };
SwitcherKey ClassifySwitcherKey(int key_code);

// Tapping Alt alone: pressed and released with nothing else in between.
class AltTap {
 public:
  // True when this event completes a tap.
  bool OnKey(bool pressed, int key_code);
  void OnMouse() { armed_ = false; }

 private:
  bool armed_ = false;
};

// Every key and mouse event in the process's windows, ahead of pages and the
// document: the app-wide event monitors macOS has. A key's release never
// reaches the browser's own key filter, and one in a page never reaches the
// document.
class WindowKeyWatch : public ui::EventHandler, public views::WidgetObserver {
 public:
  using Sink = base::RepeatingCallback<void(base::DictValue event)>;
  static WindowKeyWatch& Get();

  void Install();
  // Sends the switcher's app events to `sink` until stopped. If its modifier
  // is already up (a quick tap beat this call here), it says so at once.
  void StartSwitcher(const void* owner, views::Widget* window, Sink sink);
  void StopSwitcher(const void* owner);
  void SetAltTapHandler(base::RepeatingClosure handler);

 private:
  friend class base::NoDestructor<WindowKeyWatch>;
  WindowKeyWatch();
  ~WindowKeyWatch() override;

  void Send(const char* type, const char* key = nullptr);

  // ui::EventHandler:
  void OnKeyEvent(ui::KeyEvent* event) override;
  void OnMouseEvent(ui::MouseEvent* event) override;
  // views::WidgetObserver:
  void OnWidgetActivationChanged(views::Widget* widget, bool active) override;
  void OnWidgetDestroying(views::Widget* widget) override;

  bool installed_ = false;
  int held_ = 0;
  AltTap alt_;
  base::RepeatingClosure alt_tap_;
  const void* owner_ = nullptr;
  raw_ptr<views::Widget> window_ = nullptr;
  Sink sink_;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_WATCH_H_
