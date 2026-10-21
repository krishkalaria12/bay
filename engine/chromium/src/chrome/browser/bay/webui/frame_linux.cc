// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/frame_linux.h"

#include <memory>
#include <utility>

#include "ui/base/hit_test.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/point.h"
#include "ui/views/widget/desktop_aura/desktop_native_widget_aura.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/window/frame_view.h"
#include "ui/views/window/native_frame_view.h"

namespace bay {
namespace {

// The resize band inside each client edge, and how far along an edge from a
// corner diagonal resizing reaches. Match Chromium's own Linux frame.
constexpr int kResizeBorder = 4;
constexpr int kResizeCorner = 16;

// The client view covers the whole window. Resize edges come first, then the
// WebUI client view's CSS drag regions (HTCAPTION) and ordinary content.
// WindowEventFilterLinux turns those into compositor moves, resizes and the
// desktop's title bar double-click action.
class ClientFrame final : public views::NativeFrameView {
 public:
  explicit ClientFrame(views::Widget* widget) : NativeFrameView(widget) {}

  int NonClientHitTest(const gfx::Point& point) override {
    if (!GetLocalBounds().Contains(point))
      return HTNOWHERE;
    // Full screen pages own every pixel, including a stale caption region
    // while the UI catches up.
    if (widget_->IsFullscreen())
      return HTCLIENT;
    if (!widget_->IsMaximized() && widget_->widget_delegate()->CanResize()) {
      const int component =
          GetHTComponentForFrame(point, gfx::Insets(kResizeBorder),
                                 kResizeCorner, kResizeCorner, true);
      if (component != HTNOWHERE)
        return component;
    }
    return NativeFrameView::NonClientHitTest(point);
  }
};

class NativeWidget final : public views::DesktopNativeWidgetAura {
 public:
  explicit NativeWidget(views::Widget* widget)
      : DesktopNativeWidgetAura(widget) {}

 private:
  // Asks X11 for an undecorated window and Wayland for client-side
  // decorations. The default Linux tree host stays in charge of the window.
  void InitNativeWidget(views::Widget::InitParams params) override {
    params.remove_standard_frame = true;
    DesktopNativeWidgetAura::InitNativeWidget(std::move(params));
  }
  // Replaces the tree host's GTK or fallback frame, which would draw a second
  // title bar and caption buttons above the UI's.
  std::unique_ptr<views::FrameView> CreateFrameView() override {
    return std::make_unique<ClientFrame>(GetWidget());
  }
};

}  // namespace

// static
views::NativeWidget* FrameLinux::CreateNativeWidget(views::Widget* widget) {
  return new NativeWidget(widget);
}

}  // namespace bay
