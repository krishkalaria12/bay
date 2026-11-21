// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_WATCH_H_
#define CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_WATCH_H_

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/window_key_rules.h"
#include "ui/events/event_handler.h"
#include "ui/views/widget/widget_observer.h"

namespace views {
class Widget;
}

namespace bay {
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
  // `held` answers whether a window showed the sidebar.
  void SetAltHoldHandlers(base::RepeatingCallback<bool()> held,
                          base::RepeatingClosure released);
  // Bay has lost the front.
  void AppResigned();

 private:
  friend class base::NoDestructor<WindowKeyWatch>;
  WindowKeyWatch();
  ~WindowKeyWatch() override;

  void Send(const char* type, const char* key = nullptr);
  void ApplyAltHold(AltHold::Action action);
  void AltHoldElapsed();

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
  AltHold alt_hold_;
  base::OneShotTimer alt_hold_timer_;
  base::RepeatingCallback<bool()> alt_held_;
  base::RepeatingClosure alt_released_;
  raw_ptr<const void> owner_ = nullptr;
  raw_ptr<views::Widget> window_ = nullptr;
  Sink sink_;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_WATCH_H_
