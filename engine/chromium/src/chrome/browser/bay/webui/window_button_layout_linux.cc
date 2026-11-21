// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/window_button_layout_linux.h"

#include <utility>
#include <vector>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/task/single_thread_task_runner.h"
#include "ui/views/window/window_button_order_provider.h"

namespace bay {
namespace {
base::ListValue Buttons(const std::vector<views::FrameButton>& buttons) {
  base::ListValue result;
  for (auto button : buttons) {
    switch (button) {
      case views::FrameButton::kMinimize:
        result.Append("minimize");
        break;
      case views::FrameButton::kMaximize:
        result.Append("maximize");
        break;
      case views::FrameButton::kClose:
        result.Append("close");
        break;
    }
  }
  return result;
}
}  // namespace

WindowButtonLayoutLinux::WindowButtonLayoutLinux(base::RepeatingClosure changed)
    : WindowButtonLayoutLinux(std::move(changed),
                              views::WindowButtonOrderProvider::GetInstance(),
                              ui::LinuxUi::instance()) {}

WindowButtonLayoutLinux::WindowButtonLayoutLinux(
    base::RepeatingClosure changed,
    views::WindowButtonOrderProvider* order,
    ui::LinuxUi* linux_ui)
    : order_(order), changed_(std::move(changed)) {
  CHECK(order_);
  last_snapshot_ = Snapshot();
  if (linux_ui)
    observation_.Observe(linux_ui);
}
WindowButtonLayoutLinux::~WindowButtonLayoutLinux() = default;

base::DictValue WindowButtonLayoutLinux::Snapshot() const {
  // The provider's two vectors are already in physical left-to-right order.
  return base::DictValue()
      .Set("left", Buttons(order_->leading_buttons()))
      .Set("right", Buttons(order_->trailing_buttons()));
}

void WindowButtonLayoutLinux::SetEventSink(EventSink sink) {
  weak_factory_.InvalidateWeakPtrs();
  update_pending_ = false;
  last_event_.reset();
  event_sink_ = std::move(sink);
  ScheduleUpdate();
}
void WindowButtonLayoutLinux::OnWindowButtonOrderingChange() {
  ScheduleUpdate();
}
void WindowButtonLayoutLinux::ScheduleUpdate() {
  if (update_pending_)
    return;
  update_pending_ = true;
  // Never invoke consumers inside LinuxUi's synchronous observer iteration.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&WindowButtonLayoutLinux::DeliverUpdate,
                                weak_factory_.GetWeakPtr()));
}
void WindowButtonLayoutLinux::DeliverUpdate() {
  update_pending_ = false;
  auto layout = Snapshot();
  if (last_snapshot_ != layout) {
    last_snapshot_ = layout.Clone();
    auto weak = weak_factory_.GetWeakPtr();
    auto changed = changed_;
    if (changed)
      changed.Run();
    // A consumer may destroy the owner or replace the event connection.
    if (!weak)
      return;
    // A reentrant consumer may have changed the source again.
    if (Snapshot() != layout) {
      ScheduleUpdate();
      return;
    }
  }
  if (!event_sink_ || (last_event_ && *last_event_ == layout))
    return;
  last_event_ = layout.Clone();
  auto sink = event_sink_;
  sink.Run(std::move(layout));
}
}  // namespace bay
