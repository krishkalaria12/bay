// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/frame_win.h"

#include <windows.h>

#include <dwmapi.h>

#include <map>
#include <utility>

#include "base/command_line.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/win/windows_version.h"
#include "ui/base/hit_test.h"
#include "ui/display/win/screen_win.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/views/widget/desktop_aura/desktop_native_widget_aura.h"
#include "ui/views/widget/desktop_aura/desktop_window_tree_host_win.h"
#include "ui/views/widget/widget.h"
#include "ui/views/win/hwnd_message_handler_delegate.h"

namespace bay {
namespace {

class TreeHost;

// UI-thread lookup from a Bay window's widget to its frame.
std::map<views::Widget*, raw_ptr<TreeHost>>& Frames() {
  static base::NoDestructor<std::map<views::Widget*, raw_ptr<TreeHost>>> frames;
  return *frames;
}

class TreeHost final : public views::DesktopWindowTreeHostWin {
 public:
  TreeHost(views::internal::NativeWidgetDelegate* delegate,
           views::DesktopNativeWidgetAura* native_widget,
           bool backdrop)
      : DesktopWindowTreeHostWin(delegate, native_widget),
        backdrop_(backdrop) {}
  ~TreeHost() override { Forget(); }

  void SetCaption(std::optional<gfx::Rect> maximize, bool dark) {
    maximize_ = std::move(maximize);
    if (dark_ != dark) {
      dark_ = dark;
      ApplyBackdrop();
    }
  }

 private:
  // DWM draws the borders and shadow; the client area reaches the window's
  // top so the UI's caption replaces the native title bar. Mirrors
  // BrowserDesktopWindowTreeHostWin's native frame.
  views::FrameMode GetFrameMode() const override {
    return DesktopWindowTreeHostWin::ShouldUseNativeFrame()
               ? views::FrameMode::SYSTEM_DRAWN_NO_CONTROLS
               : views::FrameMode::CUSTOM_DRAWN;
  }
  bool GetClientAreaInsets(gfx::Insets* insets,
                           int frame_thickness) const override {
    if (IsFullscreen()) {
      *insets = gfx::Insets();
    } else {
      // Any top inset while restored makes Windows draw its own title bar.
      // Maximized windows overhang the monitor by the frame on every edge.
      *insets =
          gfx::Insets::TLBR(IsMaximized() ? frame_thickness : 0,
                            frame_thickness, frame_thickness, frame_thickness);
    }
    return true;
  }
  bool GetDwmFrameInsetsInPixels(gfx::Insets* insets) const override {
    // Glass extended into the client would make DWM draw its caption buttons
    // over the UI. The backdrop shows through the transparent UI without it.
    *insets = gfx::Insets();
    return true;
  }
  bool ShouldWindowContentsBeTransparent() const override {
    return backdrop_ ||
           DesktopWindowTreeHostWin::ShouldWindowContentsBeTransparent();
  }

  int GetNonClientComponent(const gfx::Point& point) const override {
    const int component =
        DesktopWindowTreeHostWin::GetNonClientComponent(point);
    if (component == HTNOWHERE || component == HTTRANSPARENT || IsFullscreen())
      return component;
    if (!IsMaximized()) {
      // The top resize edge lies inside the client area once the title bar is
      // gone. The side and bottom edges stay in the nonclient frame.
      const UINT dpi = ::GetDpiForWindow(GetHWND());
      const int border = ::GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) +
                         ::GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
      if (point.y() < border) {
        RECT client;
        ::GetClientRect(GetHWND(), &client);
        const int corner = ::GetSystemMetricsForDpi(SM_CXSIZE, dpi);
        if (point.x() < corner)
          return HTTOPLEFT;
        if (point.x() >= client.right - corner)
          return HTTOPRIGHT;
        return HTTOP;
      }
    }
    // Windows 11 shows Snap Layouts over HTMAXBUTTON. Mouse messages for it
    // still reach the page as nonclient events, so the UI's button handles
    // hover and click itself.
    if (maximize_ &&
        maximize_->Contains(
            display::win::GetScreenWin()->ClientToDIPPoint(GetHWND(), point)))
      return HTMAXBUTTON;
    return component;
  }

  void HandleCreate() override {
    DesktopWindowTreeHostWin::HandleCreate();
    widget_ = GetWidget();
    Frames()[widget_] = this;
    ApplyBackdrop();
  }
  void HandleDestroying() override {
    Forget();
    DesktopWindowTreeHostWin::HandleDestroying();
  }
  void Forget() {
    if (widget_)
      Frames().erase(widget_.ExtractAsDangling());
  }

  // Translucent windows get no backdrop from DesktopWindowTreeHostWin, which
  // only fills in behind opaque windows while the GPU starts.
  void ApplyBackdrop() {
    if (!backdrop_ || !GetHWND())
      return;
    const DWM_SYSTEMBACKDROP_TYPE type = DWMSBT_MAINWINDOW;
    const BOOL dark = dark_;
    if (FAILED(::DwmSetWindowAttribute(GetHWND(), DWMWA_SYSTEMBACKDROP_TYPE,
                                       &type, sizeof(type))) ||
        FAILED(::DwmSetWindowAttribute(GetHWND(), DWMWA_USE_IMMERSIVE_DARK_MODE,
                                       &dark, sizeof(dark))))
      LOG(ERROR) << "Bay couldn't apply the window backdrop";
  }

  const bool backdrop_;
  raw_ptr<views::Widget> widget_ = nullptr;
  bool dark_ = false;
  std::optional<gfx::Rect> maximize_;
};

class NativeWidget final : public views::DesktopNativeWidgetAura {
 public:
  explicit NativeWidget(views::Widget* widget)
      : DesktopNativeWidgetAura(widget) {}

 private:
  void InitNativeWidget(views::Widget::InitParams params) override {
    const bool backdrop = FrameWin::BackdropEnabled();
    if (backdrop)
      params.opacity = views::Widget::InitParams::WindowOpacity::kTranslucent;
    params.desktop_window_tree_host = new TreeHost(GetWidget(), this, backdrop);
    DesktopNativeWidgetAura::InitNativeWidget(std::move(params));
  }
};

}  // namespace

// static
views::NativeWidget* FrameWin::CreateNativeWidget(views::Widget* widget) {
  return new NativeWidget(widget);
}

// static
bool FrameWin::BackdropEnabled() {
  return base::win::GetVersion() >= base::win::Version::WIN11_22H2 &&
         !base::CommandLine::ForCurrentProcess()->HasSwitch("bay-disable-mica");
}

// static
bool FrameWin::SetCaption(views::Widget* widget,
                          std::optional<gfx::Rect> maximize,
                          bool dark) {
  auto frame = Frames().find(widget);
  if (frame == Frames().end())
    return false;
  frame->second->SetCaption(std::move(maximize), dark);
  return true;
}

}  // namespace bay
