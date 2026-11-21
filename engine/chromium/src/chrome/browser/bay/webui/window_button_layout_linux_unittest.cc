// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/window_button_layout_linux.h"

#include <memory>
#include <vector>

#include "base/observer_list.h"
#include "base/test/bind.h"
#include "base/test/task_environment.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/linux/fake_linux_ui.h"
#include "ui/views/window/window_button_order_provider.h"

namespace bay {
namespace {
using Button = views::FrameButton;
class FakeOrder : public views::WindowButtonOrderProvider {
 public:
  FakeOrder() = default;
  ~FakeOrder() override = default;
};
class LayoutLinuxUi : public ui::FakeLinuxUi {
 public:
  void AddWindowButtonOrderObserver(ui::WindowButtonOrderObserver* o) override {
    observers.AddObserver(o);
  }
  void RemoveWindowButtonOrderObserver(
      ui::WindowButtonOrderObserver* o) override {
    observers.RemoveObserver(o);
  }
  void Notify() {
    notifying = true;
    for (auto& observer : observers)
      observer.OnWindowButtonOrderingChange();
    notifying = false;
  }
  bool notifying = false;
  base::ObserverList<ui::WindowButtonOrderObserver>::Unchecked observers;
};
class WindowButtonLayoutLinuxTest : public testing::Test {
 protected:
  WindowButtonLayoutLinuxTest() {
    provider_ = std::make_unique<WindowButtonLayoutLinux>(
        base::BindLambdaForTesting([&] {
          EXPECT_FALSE(linux_ui_.notifying);
          ++updates_;
        }),
        &order_, &linux_ui_);
  }
  void Connect() {
    provider_->SetEventSink(base::BindLambdaForTesting([&](base::DictValue v) {
      EXPECT_FALSE(linux_ui_.notifying);
      events_.push_back(std::move(v));
    }));
  }
  void Set(std::vector<Button> left, std::vector<Button> right) {
    order_.SetWindowButtonOrder(left, right);
    linux_ui_.Notify();
  }
  base::test::TaskEnvironment tasks_;
  FakeOrder order_;
  LayoutLinuxUi linux_ui_;
  int updates_ = 0;
  std::vector<base::DictValue> events_;
  std::unique_ptr<WindowButtonLayoutLinux> provider_;
};
TEST_F(WindowButtonLayoutLinuxTest, InitialDefaultAndCurrentEvent) {
  auto snapshot = provider_->Snapshot();
  EXPECT_TRUE(snapshot.FindList("left")->empty());
  EXPECT_EQ(
      *snapshot.FindList("right"),
      base::ListValue().Append("minimize").Append("maximize").Append("close"));
  Connect();
  EXPECT_TRUE(events_.empty());
  tasks_.RunUntilIdle();
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(events_[0], snapshot);
  EXPECT_EQ(updates_, 0);
}
TEST_F(WindowButtonLayoutLinuxTest, PreservesBothSidesOrderingAndOmissions) {
  Set({Button::kClose, Button::kMaximize}, {Button::kMinimize});
  auto snapshot = provider_->Snapshot();
  EXPECT_EQ(*snapshot.FindList("left"),
            base::ListValue().Append("close").Append("maximize"));
  EXPECT_EQ(*snapshot.FindList("right"), base::ListValue().Append("minimize"));
  Set({}, {});
  EXPECT_TRUE(provider_->Snapshot().FindList("left")->empty());
  EXPECT_TRUE(provider_->Snapshot().FindList("right")->empty());
}
TEST_F(WindowButtonLayoutLinuxTest, CoalescesAndDeduplicatesOutsideObserver) {
  Connect();
  tasks_.RunUntilIdle();
  Set({Button::kClose}, {});
  Set({Button::kClose}, {Button::kMinimize});
  EXPECT_EQ(events_.size(), 1u);
  EXPECT_EQ(updates_, 0);
  tasks_.RunUntilIdle();
  EXPECT_EQ(updates_, 1);
  EXPECT_EQ(events_.size(), 2u);
  linux_ui_.Notify();
  tasks_.RunUntilIdle();
  EXPECT_EQ(updates_, 1);
  EXPECT_EQ(events_.size(), 2u);
}
TEST_F(WindowButtonLayoutLinuxTest, SnapshotUpdatesWithoutConnectedClient) {
  Set({Button::kClose}, {});
  tasks_.RunUntilIdle();
  EXPECT_EQ(updates_, 1);
  EXPECT_TRUE(events_.empty());
  Connect();
  tasks_.RunUntilIdle();
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(events_[0], provider_->Snapshot());
}
TEST_F(WindowButtonLayoutLinuxTest,
       ReplaceDisconnectAndReconnectCancelOldEvents) {
  int old_events = 0;
  provider_->SetEventSink(
      base::BindLambdaForTesting([&](base::DictValue) { ++old_events; }));
  Set({Button::kClose}, {});
  Connect();
  tasks_.RunUntilIdle();
  EXPECT_EQ(old_events, 0);
  EXPECT_EQ(events_.size(), 1u);
  Set({}, {});
  provider_->SetEventSink({});
  tasks_.RunUntilIdle();
  EXPECT_EQ(events_.size(), 1u);
  EXPECT_EQ(updates_, 2);
  Connect();
  tasks_.RunUntilIdle();
  ASSERT_EQ(events_.size(), 2u);
  EXPECT_EQ(events_.back(), provider_->Snapshot());
}
TEST_F(WindowButtonLayoutLinuxTest, TeardownRemovesObserverAndCancelsTasks) {
  Connect();
  Set({Button::kClose}, {});
  provider_.reset();
  EXPECT_TRUE(linux_ui_.observers.empty());
  linux_ui_.Notify();
  tasks_.RunUntilIdle();
  EXPECT_TRUE(events_.empty());
  EXPECT_EQ(updates_, 0);
}
TEST_F(WindowButtonLayoutLinuxTest, SinkCanDestroyOwner) {
  provider_->SetEventSink(
      base::BindLambdaForTesting([&](base::DictValue) { provider_.reset(); }));
  tasks_.RunUntilIdle();
  EXPECT_FALSE(provider_);
  EXPECT_TRUE(linux_ui_.observers.empty());
}
TEST_F(WindowButtonLayoutLinuxTest, ChangedCallbackCanReplaceSink) {
  provider_ = std::make_unique<WindowButtonLayoutLinux>(
      base::BindLambdaForTesting([&] { Connect(); }), &order_, &linux_ui_);
  int old_events = 0;
  provider_->SetEventSink(
      base::BindLambdaForTesting([&](base::DictValue) { ++old_events; }));
  Set({Button::kClose}, {});
  tasks_.RunUntilIdle();
  EXPECT_EQ(old_events, 0);
  ASSERT_EQ(events_.size(), 1u);
  EXPECT_EQ(events_[0], provider_->Snapshot());
}
TEST_F(WindowButtonLayoutLinuxTest, MissingToolkitStillProvidesDefault) {
  WindowButtonLayoutLinux provider(base::RepeatingClosure(), &order_, nullptr);
  EXPECT_EQ(provider.Snapshot(), provider_->Snapshot());
}
}  // namespace
}  // namespace bay
