// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/little_bay_access.h"

#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/no_destructor.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/shortcut_recorder.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/status_icons/status_icon.h"
#include "chrome/browser/status_icons/status_tray.h"
#include "chrome/grit/chrome_unscaled_resources.h"
#include "ui/base/accelerators/command.h"
#include "ui/base/resource/resource_bundle.h"
#include "ui/gfx/image/image_family.h"
#include "ui/gfx/image/image_skia.h"

#if BUILDFLAG(IS_WIN)
#include "chrome/browser/win/app_icon.h"
#endif

namespace bay {
namespace {
constexpr char16_t kTitle[] = u"New Little Bay Window";
constexpr char kCommandGroup[] = "bay";
constexpr char kOpenCommand[] = "newLittleBay";
constexpr int kOpenMenuItem = 1;

gfx::ImageSkia TrayImage() {
#if BUILDFLAG(IS_WIN)
  // Windows' tray follows the user's text size, so the icon is cut to fit it.
  std::unique_ptr<gfx::ImageFamily> family = GetAppIconImageFamily();
  return family ? family->CreateExact(GetSmallAppIconSize()).AsImageSkia()
                : gfx::ImageSkia();
#else
  return *ui::ResourceBundle::GetSharedInstance().GetImageSkiaNamed(
      IDR_PRODUCT_LOGO_128);
#endif
}
}  // namespace

// static
LittleBayAccess& LittleBayAccess::Get() {
  static base::NoDestructor<LittleBayAccess> access;
  return *access;
}
LittleBayAccess::LittleBayAccess() = default;
LittleBayAccess::~LittleBayAccess() = default;

void LittleBayAccess::SetOpenHandler(base::RepeatingClosure open) {
  open_ = std::move(open);
}
void LittleBayAccess::ClearHotKey() {
  auto* listener = ui::GlobalAcceleratorListener::GetInstance();
  if (!listener)
    return;
  if (registered_with_portal_) {
    listener->OnCommandsChanged(kCommandGroup, std::string(), ui::CommandMap(),
                                gfx::kNullAcceleratedWidget,
                                base::DoNothing());
  } else if (accelerator_) {
    listener->UnregisterAccelerator(*accelerator_, this);
  }
  registered_with_portal_ = false;
  accelerator_.reset();
}
std::string LittleBayAccess::SetHotKey(std::optional<int> key_code,
                                       const base::ListValue& modifiers) {
  ClearHotKey();
  if (!key_code)
    return "off";
  const auto accelerator = GlobalShortcutAccelerator(*key_code, modifiers);
  if (!accelerator)
    return "taken";
  auto* listener = ui::GlobalAcceleratorListener::GetInstance();
  // GNOME on Wayland, for one, has no listener Chromium can use.
  if (!listener)
    return "unavailable";
  if (listener->IsRegistrationHandledExternally()) {
    // The desktop asks the user and may choose another key; it never says
    // that the one suggested was taken.
    ui::Command command(kOpenCommand, kTitle, /*global=*/true);
    command.set_accelerator(*accelerator);
    ui::CommandMap commands;
    commands[kOpenCommand] = command;
    listener->OnCommandsChanged(
        kCommandGroup, std::string(), commands, gfx::kNullAcceleratedWidget,
        base::BindRepeating(
            [](const std::string&, const std::string&) {
              LittleBayAccess::Get().Open();
            }));
    registered_with_portal_ = true;
    accelerator_ = accelerator;
    return "ok";
  }
  if (!listener->RegisterAccelerator(*accelerator, this))
    return "taken";
  accelerator_ = accelerator;
  return "ok";
}
void LittleBayAccess::SetMenuBarItem(bool on) {
  auto* tray = g_browser_process->status_tray();
  if (!on) {
    if (status_icon_ && tray) {
      status_icon_->RemoveObserver(this);
      tray->RemoveStatusIcon(status_icon_.ExtractAsDangling());
    }
    status_icon_ = nullptr;
    return;
  }
  if (status_icon_ || !tray)
    return;
  status_icon_ = tray->CreateStatusIcon(StatusTray::OTHER_ICON, TrayImage(),
                                        kTitle);
  if (!status_icon_)
    return;
  status_icon_->AddObserver(this);
  // Some trays (GNOME's AppIndicator extension) only ever show the menu, so a
  // click alone wouldn't always reach Little Bay.
  auto menu = std::make_unique<StatusIconMenuModel>(this);
  menu->AddItem(kOpenMenuItem, kTitle);
  status_icon_->SetContextMenu(std::move(menu));
}
void LittleBayAccess::Open() {
  if (open_)
    open_.Run();
}
void LittleBayAccess::OnKeyPressed(const ui::Accelerator& accelerator) {
  Open();
}
void LittleBayAccess::ExecuteCommand(const std::string& accelerator_group_id,
                                     const std::string& command_id) {
  Open();
}
void LittleBayAccess::OnStatusIconClicked() {
  Open();
}
void LittleBayAccess::ExecuteCommand(int command_id, int event_flags) {
  Open();
}
}  // namespace bay
