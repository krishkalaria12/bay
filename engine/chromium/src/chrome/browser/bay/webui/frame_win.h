// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_FRAME_WIN_H_
#define CHROME_BROWSER_BAY_WEBUI_FRAME_WIN_H_

#include <optional>

#include "ui/gfx/geometry/rect.h"

namespace views {
class NativeWidget;
class Widget;
}  // namespace views

namespace bay {

// Bay's Win32 frame for chrome://bay windows. DWM keeps the resize borders,
// shadow, Aero Snap and the system backdrop; the UI draws the caption and its
// buttons, and reports the maximize button so Windows 11 can offer Snap
// Layouts over it.
class FrameWin {
 public:
  // WebUIBrowserWindow's native widget factory (chromium-bay-frame-win.patch).
  static views::NativeWidget* CreateNativeWidget(views::Widget* widget);

  // True when windows draw Mica behind a transparent UI: Windows 11 22H2 or
  // later, unless --bay-disable-mica asks for the solid fallback.
  static bool BackdropEnabled();

  // `maximize`: the UI's maximize button in DIPs from the window's client
  // origin, or nullopt while it shows no caption buttons. `dark`: the UI's
  // theme, which the backdrop follows. Returns false for a widget that is not
  // a Bay frame.
  static bool SetCaption(views::Widget* widget,
                         std::optional<gfx::Rect> maximize,
                         bool dark);
};

}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_FRAME_WIN_H_
