// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/frame_linux.h"

#include <memory>
#include <utility>

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/base/hit_test.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/test/widget_test.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/window/frame_view.h"
#include "ui/views/window/non_client_view.h"

namespace bay {
namespace {

class FrameLinuxTest : public views::test::DesktopWidgetTest {
 protected:
  void SetUp() override {
    DesktopWidgetTest::SetUp();
    delegate_ = std::make_unique<views::WidgetDelegate>();
    delegate_->SetCanResize(true);
    delegate_->SetCanMaximize(true);
    delegate_->SetCanFullscreen(true);
    widget_ = std::make_unique<views::Widget>();
    auto params = CreateParams(views::Widget::InitParams::CLIENT_OWNS_WIDGET,
                               views::Widget::InitParams::TYPE_WINDOW);
    params.bounds = gfx::Rect(0, 0, 400, 300);
    params.delegate = delegate_.get();
    params.native_widget = FrameLinux::CreateNativeWidget(widget_.get());
    widget_->Init(std::move(params));
  }
  void TearDown() override {
    widget_.reset();
    delegate_.reset();
    DesktopWidgetTest::TearDown();
  }

  views::FrameView* frame() { return widget_->non_client_view()->frame_view(); }
  int HitTest(int x, int y) { return frame()->NonClientHitTest({x, y}); }

  std::unique_ptr<views::WidgetDelegate> delegate_;
  std::unique_ptr<views::Widget> widget_;
};

TEST_F(FrameLinuxTest, DrawsNoSystemFrame) {
  EXPECT_FALSE(widget_->ShouldUseNativeFrame());
  EXPECT_EQ(frame()->GetBoundsForClientView(), frame()->GetLocalBounds());
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
}

TEST_F(FrameLinuxTest, MaximizedWindowsDoNotResize) {
  widget_->Maximize();
  ASSERT_TRUE(widget_->IsMaximized());
  EXPECT_EQ(HitTest(0, 0), HTCLIENT);
  EXPECT_EQ(HitTest(frame()->width() - 1, frame()->height() - 1), HTCLIENT);

  widget_->Restore();
  ASSERT_FALSE(widget_->IsMaximized());
  EXPECT_EQ(HitTest(0, 0), HTTOPLEFT);
}

TEST_F(FrameLinuxTest, FullscreenWindowsDoNotResize) {
  widget_->SetFullscreen(true);
  ASSERT_TRUE(widget_->IsFullscreen());
  EXPECT_EQ(HitTest(0, 0), HTCLIENT);
  EXPECT_EQ(HitTest(frame()->width() / 2, 0), HTCLIENT);
}

}  // namespace
}  // namespace bay
