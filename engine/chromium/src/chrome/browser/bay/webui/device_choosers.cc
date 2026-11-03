// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/device_choosers.h"

#include <map>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
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

DeviceChoosers::Sink& EventSink() {
  static base::NoDestructor<DeviceChoosers::Sink> sink;
  return *sink;
}

class Chooser;

std::map<int, std::unique_ptr<Chooser>>& Live() {
  static base::NoDestructor<std::map<int, std::unique_ptr<Chooser>>> live;
  return *live;
}

class Chooser : public permissions::ChooserController::View {
 public:
  Chooser(std::unique_ptr<permissions::ChooserController> controller,
          content::WebContents* contents)
      : controller_(std::move(controller)), contents_(contents->GetWeakPtr()) {
    static int last_id = 0;
    id_ = ++last_id;
    controller_->set_view(this);
  }
  ~Chooser() override {
    if (controller_)
      controller_->set_view(nullptr);
  }

  int id() const { return id_; }
  base::WeakPtr<Chooser> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

  void Select(int index) {
    if (!open_ || !controller_)
      return;
    std::vector<size_t> indices;
    if (index >= 0 && static_cast<size_t>(index) < controller_->NumOptions())
      indices.push_back(static_cast<size_t>(index));
    else if (!controller_->BothButtonsAlwaysEnabled())
      return;
    auto controller = Finish();
    controller->Select(indices);
    Release(std::move(controller));
  }

  void Cancel() {
    if (!open_ || !controller_)
      return;
    auto controller = Finish();
    controller->Cancel();
    Release(std::move(controller));
  }

  void Refresh() {
    if (open_ && controller_)
      controller_->RefreshOptions();
  }

  // Only the choosers that show that link have the settings; the others'
  // implementation is NOTREACHED().
  void OpenSettings() {
    if (open_ && controller_ &&
        controller_->ShouldShowAdapterUnauthorizedView()) {
      controller_->OpenPermissionPreferences();
    }
  }

  // The page's request went (navigation, the tab closing).
  void CloseFromChrome() {
    if (open_)
      Release(Finish());
  }

  void Announce() {
    announced_ = true;
    Changed();
  }

  // permissions::ChooserController::View:
  void OnOptionsInitialized() override { Changed(); }
  void OnOptionAdded(size_t index) override { Changed(); }
  void OnOptionRemoved(size_t index) override { Changed(); }
  void OnOptionUpdated(size_t index) override { Changed(); }
  void OnAdapterEnabledChanged(bool enabled) override {
    adapter_on_ = enabled;
    Changed();
  }
  void OnAdapterAuthorizationChanged(bool authorized) override {
    authorized_ = authorized;
    Changed();
  }
  void OnRefreshStateChanged(bool refreshing) override {
    refreshing_ = refreshing;
    Changed();
  }

 private:
  // The JS DeviceChooser.
  base::DictValue State() const {
    auto state =
        base::DictValue()
            .Set("id", id_)
            .Set("browserId", contents_ ? sessions::SessionTabHelper::IdForTab(
                                              contents_.get())
                                              .id()
                                        : 0)
            .Set("open", open_);
    base::ListValue options;
    if (open_ && controller_) {
      const permissions::ChooserController* c = controller_.get();
      const bool signal = c->ShouldShowIconBeforeText();
      state.Set("title", c->GetTitle());
      state.Set("okLabel", c->GetOkButtonLabel());
      state.Set("cancelLabel", c->GetCancelButtonLabel());
      state.Set("noOptionsText", c->GetNoOptionsText());
      state.Set("scanningText", c->GetThrobberLabelAndTooltip().first);
      state.Set("refreshing", refreshing_);
      state.Set("canRefresh", c->ShouldShowReScanButton());
      state.Set("adapterOff", c->ShouldShowAdapterOffView() && !adapter_on_);
      state.Set("unauthorized",
                c->ShouldShowAdapterUnauthorizedView() && !authorized_);
      state.Set("bothButtonsEnabled", c->BothButtonsAlwaysEnabled());
      state.Set("showSignal", signal);
      for (size_t i = 0; i < c->NumOptions(); ++i) {
        options.Append(base::DictValue()
                           .Set("name", c->GetOption(i))
                           .Set("connected", c->IsConnected(i))
                           .Set("paired", c->IsPaired(i))
                           .Set("signal",
                                signal ? c->GetSignalStrengthLevel(i) : -1));
      }
    }
    state.Set("options", std::move(options));
    return state;
  }

  void Changed() {
    if (!announced_ || !contents_ || !EventSink())
      return;
    const bool told = EventSink().Run(contents_.get(), "onDeviceChooser", State());
    // No window shows the tab, so nobody can answer: the page hears a refusal
    // now rather than waiting for ever. Not from inside the controller's call.
    if (!told && open_) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&DeviceChoosers::Cancel, id_));
    }
  }

  // Closed: the app hears it, and this goes on the next turn (the caller may be
  // inside it). Returns the controller to finish with.
  std::unique_ptr<permissions::ChooserController> Finish() {
    open_ = false;
    Changed();
    controller_->set_view(nullptr);
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce([](int id) { Live().erase(id); }, id_));
    return std::move(controller_);
  }

  // The controller may still be calling out: it goes after this task.
  static void Release(
      std::unique_ptr<permissions::ChooserController> controller) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->DeleteSoon(
        FROM_HERE, std::move(controller));
  }

  std::unique_ptr<permissions::ChooserController> controller_;
  base::WeakPtr<content::WebContents> contents_;
  int id_ = 0;
  bool open_ = true;
  bool announced_ = false;
  bool refreshing_ = false;
  bool adapter_on_ = true;
  bool authorized_ = true;
  base::WeakPtrFactory<Chooser> weak_factory_{this};
};

Chooser* Find(int id) {
  auto it = Live().find(id);
  return it == Live().end() ? nullptr : it->second.get();
}

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
  EventSink() = std::move(sink);
  g_bay_device_chooser = &HandleChooser;
}

// static
int DeviceChoosers::Adopt(
    std::unique_ptr<permissions::ChooserController> controller,
    content::WebContents* contents) {
  auto chooser = std::make_unique<Chooser>(std::move(controller), contents);
  Chooser* raw = chooser.get();
  const int id = raw->id();
  Live()[id] = std::move(chooser);
  // Not from inside Chrome's request: the app may answer at once.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&Chooser::Announce, raw->GetWeakPtr()));
  return id;
}

// static
void DeviceChoosers::CloseFromChrome(int id) {
  if (Chooser* chooser = Find(id))
    chooser->CloseFromChrome();
}

// static
void DeviceChoosers::Select(int id, int index) {
  if (Chooser* chooser = Find(id))
    chooser->Select(index);
}

// static
void DeviceChoosers::Cancel(int id) {
  if (Chooser* chooser = Find(id))
    chooser->Cancel();
}

// static
void DeviceChoosers::Refresh(int id) {
  if (Chooser* chooser = Find(id))
    chooser->Refresh();
}

// static
void DeviceChoosers::OpenSettings(int id) {
  if (Chooser* chooser = Find(id))
    chooser->OpenSettings();
}

}  // namespace bay
