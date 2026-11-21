// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/frame_linux.h"

#include <memory>
#include <set>
#include <string>
#include <utility>

#include "base/no_destructor.h"
#include "ui/base/hit_test.h"
#include "ui/base/ui_base_types.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/point.h"
#include "ui/platform_window/platform_window.h"
#include "ui/views/widget/desktop_aura/desktop_native_widget_aura.h"
#include "ui/views/widget/desktop_aura/desktop_window_tree_host_linux.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/window/client_view.h"
#include "ui/views/window/frame_view_layout_linux.h"
#include "ui/views/window/frame_view_linux.h"
#include "ui/views/window/non_client_view.h"

namespace bay {
namespace {

constexpr int kResizeBorder = 4;
constexpr int kResizeCorner = 16;

// Use Chromium's decoration-inset and frame-region hooks, with a solid border
// instead of a transparent shadow. The WebUI owns the entire caption area.
class ClientFrameLayout final : public views::FrameViewLayoutLinux {
 public:
  gfx::Insets GetRestoredFrameBorderInsets() const override {
    return gfx::Insets::TLBR(tiled_edges.top ? 0 : kResizeBorder,
                             tiled_edges.left ? 0 : kResizeBorder,
                             tiled_edges.bottom ? 0 : kResizeBorder,
                             tiled_edges.right ? 0 : kResizeBorder);
  }

  // The host excludes frame_insets - input_insets from the input region.
  // This border is solid and entirely interactive, with no shadow-only area.
  gfx::Insets GetInputInsets() const override { return GetFrameBorderInsets(); }

  int GetTopAreaHeight() const override { return GetFrameBorderInsets().top(); }

  bool ShouldShowTitlebarAndBorder() const override {
    return !view()->GetWidget()->IsFullscreen();
  }

  ui::WindowTiledEdges tiled_edges;
};

class ClientFrame final : public views::FrameViewLinux {
 public:
  explicit ClientFrame(views::Widget* widget)
      : FrameViewLinux(widget, new ClientFrameLayout()) {}

  void SetTiledEdges(ui::WindowTiledEdges edges) {
    if (client_layout()->tiled_edges == edges)
      return;
    client_layout()->tiled_edges = edges;
    SetTiled(edges.top || edges.left || edges.bottom || edges.right);
    // A different mask can have the same aggregate tiled state.
    InvalidateLayout();
    SchedulePaint();
  }

  int NonClientHitTest(const gfx::Point& point) override {
    if (!GetLocalBounds().Contains(point))
      return HTNOWHERE;
    // Full screen pages own every pixel, including a stale caption region
    // while the UI catches up.
    auto* widget = GetWidget();
    if (widget->IsFullscreen())
      return HTCLIENT;
    if (!widget->IsMaximized() && widget->widget_delegate()->CanResize()) {
      const auto edges = client_layout()->tiled_edges;
      const auto border = GetFrameBorderInsets();
      bool top = point.y() < border.top();
      bool bottom = point.y() >= height() - border.bottom();
      bool left = point.x() < border.left();
      bool right = point.x() >= width() - border.right();
      if (top || bottom || left || right) {
        // Only free edges may participate in diagonal resizing. Merely
        // zeroing an inset still lets GetHTComponentForFrame expand a corner
        // onto a tiled edge.
        top |= !edges.top && point.y() < kResizeCorner;
        bottom |= !edges.bottom && point.y() >= height() - kResizeCorner;
        left |= !edges.left && point.x() < kResizeCorner;
        right |= !edges.right && point.x() >= width() - kResizeCorner;
        if (top)
          return left ? HTTOPLEFT : right ? HTTOPRIGHT : HTTOP;
        if (bottom)
          return left ? HTBOTTOMLEFT : right ? HTBOTTOMRIGHT : HTBOTTOM;
        return left ? HTLEFT : HTRIGHT;
      }
    }
    if (!non_client_hit_test_callback_.is_null()) {
      const int result = non_client_hit_test_callback_.Run(point);
      if (result != HTNOWHERE)
        return result;
    }
    // CSS drag regions are relative to the WebUI, inside the frame insets.
    const int result = widget->client_view()->NonClientHitTest(
        point - widget->client_view()->bounds().OffsetFromOrigin());
    return result == HTNOWHERE ? HTCLIENT : result;
  }

  bool HasWindowTitle() const override { return false; }
  bool IsWindowTitleVisible() const override { return false; }

 private:
  void CreateCaptionButtons() override {}
  void PaintTitlebar(gfx::Canvas*) override {}

  ClientFrameLayout* client_layout() const {
    return static_cast<ClientFrameLayout*>(layout());
  }
};

// Keep the stock Linux platform window, event filter and compositor. The base
// tiling hook retains only a boolean; Bay needs each edge for layout and input.
class WindowTreeHost final : public views::DesktopWindowTreeHostLinux {
 public:
  WindowTreeHost(views::Widget* widget,
                 views::DesktopNativeWidgetAura* native_widget,
                 std::string startup_id)
      : DesktopWindowTreeHostLinux(widget, native_widget),
        startup_id_(std::move(startup_id)) {}

  // As BrowserDesktopWindowTreeHostLinux does: X11 launchers show feedback
  // until a window reports its launch complete, once per launch token.
  // Wayland consumes the same token to activate the window instead.
  void Show(ui::mojom::WindowShowState show_state,
            const gfx::Rect& restore_bounds) override {
    DesktopWindowTreeHostLinux::Show(show_state, restore_bounds);
    static base::NoDestructor<std::set<std::string>> completed;
    if (!startup_id_.empty() && completed->insert(startup_id_).second)
      platform_window()->NotifyStartupComplete(startup_id_);
    startup_id_.clear();
  }

  std::unique_ptr<views::FrameView> CreateFrameView() override {
    auto frame = std::make_unique<ClientFrame>(GetWidget());
    frame->SetTiledEdges(tiled_edges_);
    frame->InitViews();
    return frame;
  }

 private:
  void OnWindowTiledStateChanged(ui::WindowTiledEdges edges) override {
    tiled_edges_ = edges;
    auto* widget = GetWidget();
    if (widget && widget->non_client_view() &&
        widget->non_client_view()->frame_view()) {
      static_cast<ClientFrame*>(widget->non_client_view()->frame_view())
          ->SetTiledEdges(edges);
      // Tiling can change only the insets, leaving the outer bounds unchanged.
      ScheduleRelayout();
    }
    DesktopWindowTreeHostLinux::OnWindowTiledStateChanged(edges);
  }

  ui::WindowTiledEdges tiled_edges_;
  std::string startup_id_;
};

class NativeWidget final : public views::DesktopNativeWidgetAura {
 public:
  explicit NativeWidget(views::Widget* widget)
      : DesktopNativeWidgetAura(widget) {}

 private:
  void InitNativeWidget(views::Widget::InitParams params) override {
    params.remove_standard_frame = true;
    params.desktop_window_tree_host =
        new WindowTreeHost(GetWidget(), this, params.startup_id);
    DesktopNativeWidgetAura::InitNativeWidget(std::move(params));
  }
};

}  // namespace

// static
views::NativeWidget* FrameLinux::CreateNativeWidget(views::Widget* widget) {
  return new NativeWidget(widget);
}

}  // namespace bay
