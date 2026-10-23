// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_FRAME_LINUX_H_
#define CHROME_BROWSER_BAY_WEBUI_FRAME_LINUX_H_

namespace views {
class NativeWidget;
class Widget;
}  // namespace views

namespace bay {

// Bay's client-side frame for chrome://bay windows on X11 and Wayland. The
// window has no system title bar and no Views caption; the UI draws the
// caption and its buttons, CSS drag regions move the window, and a thin solid
// border provides restored-window insets and resize handles on untiled edges.
class FrameLinux {
 public:
  // WebUIBrowserWindow's factory (chromium-bay-native-widget.patch).
  static views::NativeWidget* CreateNativeWidget(views::Widget* widget);
};

}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_FRAME_LINUX_H_
