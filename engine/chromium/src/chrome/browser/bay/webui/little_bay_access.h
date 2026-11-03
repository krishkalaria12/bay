// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_LITTLE_BAY_ACCESS_H_
#define CHROME_BROWSER_BAY_WEBUI_LITTLE_BAY_ACCESS_H_

#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/no_destructor.h"
#include "base/memory/raw_ptr.h"
#include "base/values.h"
#include "chrome/browser/status_icons/status_icon_menu_model.h"
#include "chrome/browser/status_icons/status_icon_observer.h"
#include "ui/base/accelerators/accelerator.h"
// NOLINTNEXTLINE(whitespace/line_length)
#include "ui/base/accelerators/global_accelerator_listener/global_accelerator_listener.h"

class StatusIcon;

namespace bay {
// Little Bay from any app (LittleBayAccess.swift): a global shortcut and a tray
// icon, each opening a Little Bay ready to type. Process-wide, as both outlive
// any one window's document.
class LittleBayAccess : public ui::GlobalAcceleratorListener::Observer,
                        public StatusIconObserver,
                        public StatusIconMenuModel::Delegate {
 public:
  static LittleBayAccess& Get();

  // Runs when the shortcut or tray icon is used.
  void SetOpenHandler(base::RepeatingClosure open);
  // "ok", "off" (no key), "taken" (another app has it), or "unavailable" (this
  // desktop offers no global shortcuts).
  std::string SetHotKey(std::optional<int> key_code,
                        const base::ListValue& modifiers);
  void SetMenuBarItem(bool on);

 private:
  friend class base::NoDestructor<LittleBayAccess>;
  LittleBayAccess();
  ~LittleBayAccess() override;

  void ClearHotKey();
  void Open();

  // ui::GlobalAcceleratorListener::Observer:
  void OnKeyPressed(const ui::Accelerator& accelerator) override;
  void ExecuteCommand(const std::string& accelerator_group_id,
                      const std::string& command_id) override;
  // StatusIconObserver:
  void OnStatusIconClicked() override;
  // StatusIconMenuModel::Delegate:
  void ExecuteCommand(int command_id, int event_flags) override;

  base::RepeatingClosure open_;
  std::optional<ui::Accelerator> accelerator_;
  // The XDG portal registers shortcuts as command groups, not accelerators.
  bool registered_with_portal_ = false;
  raw_ptr<StatusIcon> status_icon_ = nullptr;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_LITTLE_BAY_ACCESS_H_
