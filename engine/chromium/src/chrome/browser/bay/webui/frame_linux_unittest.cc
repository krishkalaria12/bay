// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/frame_linux.h"

#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/base/hit_test.h"
#include "ui/base/ui_base_types.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/platform_window/platform_window_delegate.h"
#include "ui/views/test/widget_test.h"
#include "ui/views/widget/desktop_aura/desktop_native_widget_aura.h"
#include "ui/views/widget/desktop_aura/desktop_window_tree_host_platform.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/window/client_view.h"
#include "ui/views/window/frame_view_linux.h"
#include "ui/views/window/non_client_view.h"

namespace bay {
namespace {

// Mirrors WebUIBrowserClientView's client-local CSS drag region lookup.
class DragClientView : public views::ClientView {
 public:
  explicit DragClientView(views::Widget* widget)
      : ClientView(widget, nullptr) {}

  int NonClientHitTest(const gfx::Point& point) override {
    if (gfx::Rect(20, 0, 100, 30).Contains(point))
      return HTCAPTION;
    return ClientView::NonClientHitTest(point);
  }
};

class FrameDelegate : public views::WidgetDelegate {
 public:
  views::ClientView* CreateClientView(views::Widget* widget) override {
    return new DragClientView(widget);
  }
};

class FrameLinuxTest : public views::test::DesktopWidgetTest {
 protected:
  void SetUp() override {
    DesktopWidgetTest::SetUp();
    delegate_ = std::make_unique<FrameDelegate>();
    delegate_->SetCanResize(true);
    delegate_->SetCanMaximize(true);
    delegate_->SetCanFullscreen(true);
    widget_ = std::make_unique<views::Widget>();
    auto params = CreateParams(views::Widget::InitParams::CLIENT_OWNS_WIDGET,
                               views::Widget::InitParams::TYPE_WINDOW);
    params.bounds = gfx::Rect(0, 0, 400, 300);
    params.delegate = delegate_.get();
    native_widget_ = static_cast<views::DesktopNativeWidgetAura*>(
        FrameLinux::CreateNativeWidget(widget_.get()));
    params.native_widget = native_widget_;
    widget_->Init(std::move(params));
    widget_->LayoutRootViewIfNecessary();
  }
  void TearDown() override {
    native_widget_ = nullptr;
    widget_.reset();
    delegate_.reset();
    DesktopWidgetTest::TearDown();
  }

  views::FrameViewLinux* frame() {
    return views::AsViewClass<views::FrameViewLinux>(
        widget_->non_client_view()->frame_view());
  }
  ui::PlatformWindowDelegate* host() {
    return static_cast<views::DesktopWindowTreeHostPlatform*>(
        native_widget_->desktop_window_tree_host_for_testing());
  }
  void Tile(ui::WindowTiledEdges edges) {
    host()->OnWindowTiledStateChanged(edges);
    widget_->LayoutRootViewIfNecessary();
  }
  void ExpectInsets(const gfx::Insets& insets) {
    EXPECT_EQ(frame()->GetFrameBorderInsets(), insets);
    auto client = frame()->GetLocalBounds();
    client.Inset(insets);
    EXPECT_EQ(frame()->GetBoundsForClientView(), client);
    EXPECT_EQ(widget_->client_view()->bounds(), client);
    EXPECT_EQ(frame()->GetWindowBoundsForClientBounds(client),
              frame()->GetLocalBounds());
    // Match DesktopWindowTreeHostLinux::UpdateFrameRegions. With a solid
    // border, decoration insets must not remove the resize handles from input.
    auto input_region = frame()->GetLocalBounds();
    input_region.Inset(frame()->GetFrameBorderInsets() -
                       frame()->GetInputInsets());
    EXPECT_EQ(input_region, frame()->GetLocalBounds());
    EXPECT_EQ(frame()->GetInputInsets(), insets);
  }
  int HitTest(int x, int y) { return frame()->NonClientHitTest({x, y}); }

  raw_ptr<views::DesktopNativeWidgetAura> native_widget_ = nullptr;
  std::unique_ptr<FrameDelegate> delegate_;
  std::unique_ptr<views::Widget> widget_;
};

TEST_F(FrameLinuxTest, DrawsNoSystemFrame) {
  EXPECT_FALSE(widget_->ShouldUseNativeFrame());
  ASSERT_NE(frame(), nullptr);
  EXPECT_FALSE(frame()->HasWindowTitle());
  EXPECT_EQ(frame()->minimize_button(), nullptr);
  EXPECT_EQ(frame()->maximize_button(), nullptr);
  EXPECT_EQ(frame()->restore_button(), nullptr);
  EXPECT_EQ(frame()->close_button(), nullptr);
  EXPECT_FALSE(frame()->ShouldDrawRestoredFrameShadow());
  EXPECT_EQ(frame()->GetInputInsets(), gfx::Insets(4));
  ExpectInsets(gfx::Insets(4));
}

TEST_F(FrameLinuxTest, ResizesFromEdgesAndCorners) {
  const int w = frame()->width();
  const int h = frame()->height();
  EXPECT_EQ(HitTest(0, 0), HTTOPLEFT);
  EXPECT_EQ(HitTest(15, 0), HTTOPLEFT);
  EXPECT_EQ(HitTest(w / 2, 0), HTTOP);
  EXPECT_EQ(HitTest(w - 1, 0), HTTOPRIGHT);
  EXPECT_EQ(HitTest(0, h / 2), HTLEFT);
  EXPECT_EQ(HitTest(w - 1, h / 2), HTRIGHT);
  EXPECT_EQ(HitTest(0, h - 1), HTBOTTOMLEFT);
  EXPECT_EQ(HitTest(w / 2, h - 1), HTBOTTOM);
  EXPECT_EQ(HitTest(w - 1, h - 1), HTBOTTOMRIGHT);
}

TEST_F(FrameLinuxTest, LeavesTheInteriorToTheClient) {
  EXPECT_EQ(HitTest(frame()->width() / 2, frame()->height() / 2), HTCLIENT);
  EXPECT_EQ(HitTest(4, 4), HTCLIENT);
}

TEST_F(FrameLinuxTest, IgnoresPointsOutsideTheWindow) {
  EXPECT_EQ(HitTest(-1, 10), HTNOWHERE);
  EXPECT_EQ(HitTest(10, frame()->height()), HTNOWHERE);
}

TEST_F(FrameLinuxTest, FixedSizeWindowsDoNotResize) {
  delegate_->SetCanResize(false);
  EXPECT_EQ(HitTest(0, 0), HTCLIENT);
  EXPECT_EQ(HitTest(frame()->width() / 2, 0), HTCLIENT);
  Tile({.left = true});
  ExpectInsets(gfx::Insets::TLBR(4, 0, 4, 4));
  EXPECT_EQ(HitTest(frame()->width() - 1, 0), HTCLIENT);
}

TEST_F(FrameLinuxTest, MaximizedWindowsDoNotResize) {
  widget_->Maximize();
  ASSERT_TRUE(widget_->IsMaximized());
  widget_->LayoutRootViewIfNecessary();
  ExpectInsets(gfx::Insets());
  EXPECT_EQ(HitTest(0, 0), HTCLIENT);
  EXPECT_EQ(HitTest(frame()->width() - 1, frame()->height() - 1), HTCLIENT);

  widget_->Restore();
  ASSERT_FALSE(widget_->IsMaximized());
  widget_->LayoutRootViewIfNecessary();
  ExpectInsets(gfx::Insets(4));
  EXPECT_EQ(HitTest(0, 0), HTTOPLEFT);
}

TEST_F(FrameLinuxTest, FullscreenWindowsDoNotResize) {
  widget_->SetFullscreen(true);
  ASSERT_TRUE(widget_->IsFullscreen());
  widget_->LayoutRootViewIfNecessary();
  ExpectInsets(gfx::Insets());
  EXPECT_EQ(HitTest(0, 0), HTCLIENT);
  EXPECT_EQ(HitTest(frame()->width() / 2, 0), HTCLIENT);
}

TEST_F(FrameLinuxTest, RestoredGeometryEnclosesTheClient) {
  const gfx::Rect client_bounds(100, 100, 320, 240);
  EXPECT_EQ(frame()->GetWindowBoundsForClientBounds(client_bounds),
            gfx::Rect(96, 96, 328, 248));
  EXPECT_EQ(host()->CalculateInsetsInDIP(ui::PlatformWindowState::kNormal),
            gfx::Insets(4));
  for (auto state : {ui::PlatformWindowState::kMaximized,
                     ui::PlatformWindowState::kFullScreen,
                     ui::PlatformWindowState::kMinimized}) {
    EXPECT_EQ(host()->CalculateInsetsInDIP(state), gfx::Insets());
  }
}

TEST_F(FrameLinuxTest, EveryTiledEdgeMaskChangesGeometryAndResizeHandles) {
  for (int mask = 0; mask < 16; ++mask) {
    SCOPED_TRACE(mask);
    const ui::WindowTiledEdges edges{.left = !!(mask & 1),
                                     .right = !!(mask & 2),
                                     .top = !!(mask & 4),
                                     .bottom = !!(mask & 8)};
    Tile(edges);
    const auto insets =
        gfx::Insets::TLBR(edges.top ? 0 : 4, edges.left ? 0 : 4,
                          edges.bottom ? 0 : 4, edges.right ? 0 : 4);
    ExpectInsets(insets);
    EXPECT_EQ(host()->CalculateInsetsInDIP(ui::PlatformWindowState::kNormal),
              insets);
    EXPECT_EQ(frame()->GetWindowBoundsForClientBounds({100, 100, 200, 100}),
              gfx::Rect(100 - insets.left(), 100 - insets.top(),
                        200 + insets.width(), 100 + insets.height()));
    const int w = frame()->width();
    const int h = frame()->height();
    EXPECT_EQ(HitTest(w / 2, 0), edges.top ? HTCLIENT : HTTOP);
    EXPECT_EQ(HitTest(w / 2, h - 1), edges.bottom ? HTCLIENT : HTBOTTOM);
    EXPECT_EQ(HitTest(0, h / 2), edges.left ? HTCLIENT : HTLEFT);
    EXPECT_EQ(HitTest(w - 1, h / 2), edges.right ? HTCLIENT : HTRIGHT);
    EXPECT_EQ(HitTest(0, 0), edges.top ? (edges.left ? HTCLIENT : HTLEFT)
                                       : (edges.left ? HTTOP : HTTOPLEFT));
    EXPECT_EQ(HitTest(w - 1, h - 1),
              edges.bottom ? (edges.right ? HTCLIENT : HTRIGHT)
                           : (edges.right ? HTBOTTOM : HTBOTTOMRIGHT));
  }
}

TEST_F(FrameLinuxTest, InsetOnlyTilingTransitionsRelayoutTheClient) {
  const auto outer_bounds = widget_->GetWindowBoundsInScreen();
  Tile({.left = true});
  ExpectInsets(gfx::Insets::TLBR(4, 0, 4, 4));
  Tile({.right = true});
  ExpectInsets(gfx::Insets::TLBR(4, 4, 4, 0));
  Tile({.left = true, .right = true, .top = true, .bottom = true});
  ExpectInsets(gfx::Insets());
  Tile({});
  ExpectInsets(gfx::Insets(4));
  EXPECT_EQ(widget_->GetWindowBoundsInScreen(), outer_bounds);
}

TEST_F(FrameLinuxTest, DragRegionsTrackTheInsetClientOrigin) {
  EXPECT_EQ(HitTest(20, 10), HTCLIENT);
  EXPECT_EQ(HitTest(24, 10), HTCAPTION);
  EXPECT_EQ(HitTest(123, 10), HTCAPTION);
  EXPECT_EQ(HitTest(124, 10), HTCLIENT);
  EXPECT_EQ(HitTest(30, 0), HTTOP);
  Tile({.left = true, .top = true});
  EXPECT_EQ(HitTest(20, 0), HTCAPTION);
  EXPECT_EQ(HitTest(120, 0), HTCLIENT);
  delegate_->SetCanResize(false);
  EXPECT_EQ(HitTest(30, 10), HTCAPTION);
  widget_->SetFullscreen(true);
  ASSERT_TRUE(widget_->IsFullscreen());
  EXPECT_EQ(HitTest(30, 10), HTCLIENT);
}

TEST_F(FrameLinuxTest,
       CallbackFallsThroughAndCannotOverrideResizeOrFullscreen) {
  frame()->set_non_client_hit_test_callback(
      base::BindRepeating([](const gfx::Point&) -> int { return HTNOWHERE; }));
  EXPECT_EQ(HitTest(30, 10), HTCAPTION);
  frame()->set_non_client_hit_test_callback(
      base::BindRepeating([](const gfx::Point&) -> int { return HTCAPTION; }));
  EXPECT_EQ(HitTest(200, 10), HTCAPTION);
  EXPECT_EQ(HitTest(0, 0), HTTOPLEFT);
  widget_->SetFullscreen(true);
  ASSERT_TRUE(widget_->IsFullscreen());
  EXPECT_EQ(HitTest(200, 10), HTCLIENT);
}

}  // namespace
}  // namespace bay
