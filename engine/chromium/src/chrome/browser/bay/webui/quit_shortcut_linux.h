// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_QUIT_SHORTCUT_LINUX_H_
#define CHROME_BROWSER_BAY_WEBUI_QUIT_SHORTCUT_LINUX_H_

#include "ui/base/accelerators/accelerator.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"

namespace bay {

// Linux desktops quit an app with Ctrl+Q; Chrome's own table quits with
// Ctrl+Shift+Q, which keeps working. Only Ctrl alone counts: Super belongs to
// the compositor, and Q with Alt or Shift is a page's to use. A held key's
// repeats don't ask again.
inline bool IsLinuxQuitShortcut(const ui::Accelerator& accelerator) {
  // Equality compares the key, its state and the modifier keys only, so a
  // synthesized Ctrl+Q still counts.
  return accelerator == ui::Accelerator(ui::VKEY_Q, ui::EF_CONTROL_DOWN) &&
         !accelerator.IsRepeat();
}

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_QUIT_SHORTCUT_LINUX_H_
