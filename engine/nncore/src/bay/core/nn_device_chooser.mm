// The macOS host's side of the shared device choosers (nn_device_choosers.cc): the
// cef::HandleDeviceChooser seam, the host's dictionaries and the test Bluetooth chooser.

#include "bay/core/nn_device_chooser.h"

#import <Foundation/Foundation.h>

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/values.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/bluetooth/chrome_bluetooth_chooser_controller.h"
#include "components/permissions/bluetooth_chooser_controller.h"
#include "components/permissions/chooser_controller.h"
#include "content/public/browser/bluetooth_chooser.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "bay/core/nn_browser.h"
#include "bay/core/nn_device_choosers.h"
#include "bay/core/nn_external_apps.h"

namespace nncore {

namespace {

// The shared chooser's state, as the host's dictionary.
NSDictionary* Dictionary(const base::DictValue& state) {
  std::optional<std::string> json = base::WriteJson(state);
  NSData* data = json ? [NSData dataWithBytes:json->data() length:json->size()] : nil;
  id object = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [object isKindOfClass:NSDictionary.class] ? object : @{};
}

int Adopt(std::unique_ptr<permissions::ChooserController> controller,
          content::WebContents* contents) {
  static bool told = [] {
    choosers::SetTell(base::BindRepeating([](content::WebContents* contents,
                                             base::DictValue state) {
      HostDeviceChooser(contents, Dictionary(state));
      return true;
    }));
    return true;
  }();
  (void)told;
  return choosers::Adopt(std::move(controller), contents);
}

// --bay-test-bluetooth-chooser: a Bluetooth chooser with no adapter behind it (a real
// one wakes IOBluetooth, and macOS asks for Bluetooth access), for test runs.
constexpr char kTestBluetoothChooserSwitch[] = "bay-test-bluetooth-chooser";

NSMutableArray<NSDictionary*>* TestEvents() {
  static NSMutableArray<NSDictionary*>* events = [NSMutableArray array];
  return events;
}

NSString* EventName(content::BluetoothChooserEvent event) {
  switch (event) {
    case content::BluetoothChooserEvent::DENIED_PERMISSION:
      return @"denied";
    case content::BluetoothChooserEvent::CANCELLED:
      return @"cancelled";
    case content::BluetoothChooserEvent::SELECTED:
      return @"selected";
    case content::BluetoothChooserEvent::RESCAN:
      return @"rescan";
    case content::BluetoothChooserEvent::SHOW_OVERVIEW_HELP:
      return @"overviewHelp";
    case content::BluetoothChooserEvent::SHOW_ADAPTER_OFF_HELP:
      return @"adapterOffHelp";
    case content::BluetoothChooserEvent::SHOW_NEED_LOCATION_HELP:
      return @"needLocationHelp";
  }
  return @"unknown";
}

// What the adapter would report: no access, or on with one device found and the scan over.
void DriveTestBluetoothChooser(int chooser_id, bool unauthorized) {
  auto* controller =
      static_cast<permissions::BluetoothChooserController*>(choosers::Controller(chooser_id));
  if (!controller) {
    return;
  }
  using content::BluetoothChooser;
  if (unauthorized) {
    controller->OnAdapterPresenceChanged(BluetoothChooser::AdapterPresence::UNAUTHORIZED);
    return;
  }
  controller->OnAdapterPresenceChanged(BluetoothChooser::AdapterPresence::POWERED_ON);
  controller->AddOrUpdateDevice("nn-test-device", /*should_update_name=*/false,
                                u"Bay Test Device", /*is_gatt_connected=*/false,
                                /*is_paired=*/false, /*signal_strength_level=*/3);
  controller->OnDiscoveryStateChanged(BluetoothChooser::DiscoveryState::IDLE);
}

}  // namespace

bool HandleDeviceChooser(content::RenderFrameHost* owner,
                         std::unique_ptr<permissions::ChooserController>* controller,
                         base::OnceClosure* close_closure) {
  content::WebContents* contents =
      owner ? content::WebContents::FromRenderFrameHost(owner) : nullptr;
  BrowserWindowInterface* browser =
      contents ? GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents)
               : nullptr;
  if (!browser || !WindowHost::ForBrowser(browser) || !controller || !*controller ||
      !HostWantsDeviceChoosers()) {
    return false;
  }
  *close_closure = base::BindOnce(&choosers::CloseFromChrome,
                                  Adopt(std::move(*controller), contents));
  return true;
}

bool ShowTestBluetoothChooser(content::WebContents* contents, bool unauthorized) {
  if (!contents || !contents->GetPrimaryMainFrame() ||
      !base::CommandLine::ForCurrentProcess()->HasSwitch(kTestBluetoothChooserSwitch) ||
      !HostWantsDeviceChoosers()) {
    return false;
  }
  // Chrome's own controller with a recorder where content's adapter-driving one would be.
  auto chooser_id = std::make_shared<int>(0);
  auto handler = base::BindRepeating(
      [](std::shared_ptr<int> chooser_id, content::BluetoothChooserEvent event,
         const std::string& device) {
        [TestEvents() addObject:@{
          @"event" : EventName(event),
          @"device" : base::SysUTF8ToNSString(device),
        }];
        if (event == content::BluetoothChooserEvent::RESCAN) {
          // A scan finds the device again, then ends (after this call returns).
          base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
              FROM_HERE, base::BindOnce(&DriveTestBluetoothChooser, *chooser_id, false));
        }
      },
      chooser_id);
  *chooser_id = Adopt(std::make_unique<ChromeBluetoothChooserController>(
                          contents->GetPrimaryMainFrame(), handler),
                      contents);
  // After the host heard of it (Adopt's announcement goes first).
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&DriveTestBluetoothChooser, *chooser_id, unauthorized));
  return true;
}

NSArray<NSDictionary*>* TestChooserEvents() {
  return [TestEvents() copy];
}

void SelectDevice(int chooser_id, int index) {
  choosers::Select(chooser_id, index);
}

void CancelDeviceChooser(int chooser_id) {
  choosers::Cancel(chooser_id);
}

void RefreshDeviceChooser(int chooser_id) {
  choosers::Refresh(chooser_id);
}

// Bluetooth's privacy settings; a test run records them rather than opening them.
void OpenDeviceChooserSettings(int chooser_id) {
  if (!choosers::OffersSettings(chooser_id)) {
    return;
  }
  if (TestNoLaunch()) {
    RecordTestLaunch(@{
      @"url" : @"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?"
               @"Privacy_Bluetooth",
      @"settings" : @"bluetooth",
    });
    return;
  }
  choosers::OpenSettings(chooser_id);
}

}  // namespace nncore
