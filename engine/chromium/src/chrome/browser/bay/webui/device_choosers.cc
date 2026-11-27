// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/device_choosers.h"

#include <utility>

#include "bay/core/nn_device_choosers.h"
#include "base/functional/bind.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "components/permissions/chooser_controller.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

// Defined in Chrome's chooser (chromium-chrome-dialogs-webui.patch).
extern bool (*g_bay_device_chooser)(
    content::RenderFrameHost* owner,
    std::unique_ptr<permissions::ChooserController>* controller,
    base::OnceClosure* close_closure);

namespace bay {
namespace {

bool HandleChooser(content::RenderFrameHost* owner,
                   std::unique_ptr<permissions::ChooserController>* controller,
                   base::OnceClosure* close_closure) {
  auto* contents =
      owner ? content::WebContents::FromRenderFrameHost(owner) : nullptr;
  // A window Chrome made itself keeps Chrome's chooser.
  if (!WindowRegistry::Get().HoldsTab(contents) || !controller || !*controller)
    return false;
  const int id = DeviceChoosers::Adopt(std::move(*controller), contents);
  *close_closure = base::BindOnce(&DeviceChoosers::CloseFromChrome, id);
  return true;
}

}  // namespace

// static
void DeviceChoosers::Start(Sink sink) {
  nncore::choosers::SetTell(base::BindRepeating(
      [](const Sink& sink, content::WebContents* contents,
         base::DictValue state) {
        state.Set("browserId",
                  sessions::SessionTabHelper::IdForTab(contents).id());
        return sink.Run(contents, "onDeviceChooser", std::move(state));
      },
      std::move(sink)));
  g_bay_device_chooser = &HandleChooser;
}

// static
int DeviceChoosers::Adopt(
    std::unique_ptr<permissions::ChooserController> controller,
    content::WebContents* contents) {
  return nncore::choosers::Adopt(std::move(controller), contents);
}

// static
void DeviceChoosers::CloseFromChrome(int id) {
  nncore::choosers::CloseFromChrome(id);
}

// static
void DeviceChoosers::Select(int id, int index) {
  nncore::choosers::Select(id, index);
}

// static
void DeviceChoosers::Cancel(int id) {
  nncore::choosers::Cancel(id);
}

// static
void DeviceChoosers::Refresh(int id) {
  nncore::choosers::Refresh(id);
}

// static
void DeviceChoosers::OpenSettings(int id) {
  nncore::choosers::OpenSettings(id);
}

}  // namespace bay
