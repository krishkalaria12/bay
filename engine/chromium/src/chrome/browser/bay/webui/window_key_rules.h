// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_RULES_H_
#define CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_RULES_H_

#include "base/time/time.h"

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

// Alt held on its own, to show the hidden sidebar, as the flags monitor in
// ShellModule.swift decides. Only after a beat, so Alt on the way to a shortcut
// shows nothing, nor while typing. A key or a click stops a hold that hasn't
// shown; one that has stays until Alt goes up or joins another modifier.
class AltHold {
 public:
  static constexpr base::TimeDelta kDelay = base::Milliseconds(200);
  static constexpr base::TimeDelta kTypingPause = base::Seconds(1);

  enum class Action { kNone, kStart, kCancel, kRelease };
  Action OnKey(bool pressed, int key_code, int flags, base::TimeTicks now);
  Action OnMouse();
  // Stops either way. Bay losing the front ends here too: Alt's release may
  // never come (Alt+Tab).
  Action OnLeft();
  // The delay ran out and the sidebar was shown.
  void Shown();
  bool shown() const { return shown_; }

 private:
  bool pending_ = false;
  bool shown_ = false;
  base::TimeTicks last_key_;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_WINDOW_KEY_RULES_H_
