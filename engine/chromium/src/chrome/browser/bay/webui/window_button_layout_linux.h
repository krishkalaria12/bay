// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_WINDOW_BUTTON_LAYOUT_LINUX_H_
#define CHROME_BROWSER_BAY_WEBUI_WINDOW_BUTTON_LAYOUT_LINUX_H_

#include <optional>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "ui/linux/linux_ui.h"
#include "ui/linux/window_button_order_observer.h"

namespace views {
class WindowButtonOrderProvider;
}

namespace bay {
// UI-sequence, document-owned access to Chromium's desktop button order. The
// initial value is Chromium's current order, possibly its default before the
// desktop settings arrive. LinuxUi must outlive this observer.
class WindowButtonLayoutLinux final : public ui::WindowButtonOrderObserver {
 public:
  using EventSink = base::RepeatingCallback<void(base::DictValue)>;
  explicit WindowButtonLayoutLinux(base::RepeatingClosure changed);
  WindowButtonLayoutLinux(base::RepeatingClosure changed,
                          views::WindowButtonOrderProvider* order,
                          ui::LinuxUi* linux_ui);
  ~WindowButtonLayoutLinux() override;

  base::DictValue Snapshot() const;
  // Each connection receives the current value. Replacing or clearing the sink
  // cancels queued delivery to the previous connection.
  void SetEventSink(EventSink sink);

 private:
  void OnWindowButtonOrderingChange() override;
  void ScheduleUpdate();
  void DeliverUpdate();

  const raw_ptr<views::WindowButtonOrderProvider> order_;
  base::RepeatingClosure changed_;
  EventSink event_sink_;
  base::DictValue last_snapshot_;
  std::optional<base::DictValue> last_event_;
  bool update_pending_ = false;
  base::ScopedObservation<ui::LinuxUi, ui::WindowButtonOrderObserver>
      observation_{this};
  base::WeakPtrFactory<WindowButtonLayoutLinux> weak_factory_{this};
};
}  // namespace bay
#endif
