// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/cast_dialogs.h"

#include <map>
#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/ui/media_router/cast_dialog_controller.h"
#include "chrome/browser/ui/media_router/cast_dialog_model.h"
#include "chrome/browser/ui/media_router/media_cast_mode.h"
#include "chrome/browser/ui/media_router/media_router_ui.h"
#include "chrome/browser/ui/media_router/ui_media_sink.h"
#include "components/media_router/browser/media_router_dialog_controller.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/web_contents.h"

// Defined in Chrome's dialog controller (chromium-chrome-dialogs-webui.patch).
extern bool (*g_bay_wants_cast_dialog)(content::WebContents* initiator);
extern bool (*g_bay_cast_dialog)(content::WebContents* initiator,
                                 media_router::MediaRouterUI* ui);

namespace bay {
namespace {

CastDialogs::Sink& EventSink() {
  static base::NoDestructor<CastDialogs::Sink> sink;
  return *sink;
}

const char* SinkState(media_router::UIMediaSinkState state) {
  switch (state) {
    case media_router::UIMediaSinkState::AVAILABLE:
      return "available";
    case media_router::UIMediaSinkState::CONNECTING:
      return "connecting";
    case media_router::UIMediaSinkState::CONNECTED:
      return "connected";
    case media_router::UIMediaSinkState::DISCONNECTING:
      return "disconnecting";
    case media_router::UIMediaSinkState::UNAVAILABLE:
      return "unavailable";
  }
  return "unavailable";
}

class Dialog;

std::map<int, std::unique_ptr<Dialog>>& Live() {
  static base::NoDestructor<std::map<int, std::unique_ptr<Dialog>>> live;
  return *live;
}

class Dialog : public media_router::CastDialogController::Observer {
 public:
  Dialog(content::WebContents* initiator, media_router::MediaRouterUI* ui)
      : initiator_(initiator->GetWeakPtr()), ui_(ui->GetWeakPtr()) {
    static int last_id = 0;
    id_ = ++last_id;
  }
  ~Dialog() override { Detach(); }

  int id() const { return id_; }

  void Start() {
    // Reports the current model right away (OnModelUpdated).
    if (ui_)
      ui_->AddObserver(this);
    announced_ = true;
    Notify();
  }

  void StartCasting(const std::string& sink, media_router::MediaCastMode mode) {
    if (ui_)
      ui_->StartCasting(sink, mode);
  }

  void StopCasting(const std::string& route) {
    if (ui_)
      ui_->StopCasting(route);
  }

  void Close() {
    if (!open_)
      return;
    // Destroys the MediaRouterUI (OnControllerDestroying).
    if (initiator_) {
      media_router::MediaRouterDialogController::GetOrCreateForWebContents(
          initiator_.get())
          ->HideMediaRouterDialog();
    }
    if (open_) {
      Detach();
      Notify();
      Forget();
    }
  }

  // media_router::CastDialogController::Observer:
  void OnModelUpdated(const media_router::CastDialogModel& model) override {
    sinks_ = base::ListValue();
    for (const auto& sink : model.media_sinks())
      sinks_.Append(CastDialogs::DescribeSink(sink));
    header_ = model.dialog_header();
    permission_rejected_ = model.is_permission_rejected();
    Notify();
  }

  void OnCastingStarted() override {
    casting_started_ = true;
    Notify();
  }

  void OnControllerDestroying() override {
    ui_.reset();
    Detach();
    Notify();
    Forget();
  }

 private:
  // The JS CastDialog.
  base::DictValue State() const {
    return base::DictValue()
        .Set("id", id_)
        .Set("browserId",
             initiator_
                 ? sessions::SessionTabHelper::IdForTab(initiator_.get()).id()
                 : 0)
        .Set("open", open_)
        .Set("header", header_)
        .Set("permissionRejected", permission_rejected_)
        .Set("castingStarted", casting_started_)
        .Set("sinks", sinks_.Clone());
  }

  void Notify() {
    if (!announced_ || !initiator_ || !EventSink())
      return;
    const bool told = EventSink().Run(initiator_.get(), "onCastDialog", State());
    // No window shows the tab, so nobody can use it: it closes. Not from inside
    // the model's own call.
    if (!told && open_) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&CastDialogs::Close, id_));
    }
  }

  void Detach() {
    if (ui_) {
      ui_->RemoveObserver(this);
      ui_.reset();
    }
    open_ = false;
  }

  // Goes after this turn (it may be inside its own call).
  void Forget() {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce([](int id) { Live().erase(id); }, id_));
  }

  base::WeakPtr<content::WebContents> initiator_;
  base::WeakPtr<media_router::MediaRouterUI> ui_;
  int id_ = 0;
  bool open_ = true;
  bool announced_ = false;
  bool casting_started_ = false;
  bool permission_rejected_ = false;
  std::u16string header_;
  base::ListValue sinks_;
};

Dialog* Find(int id) {
  auto it = Live().find(id);
  return it == Live().end() ? nullptr : it->second.get();
}

// A window Chrome made itself keeps Chrome's dialog.
bool WantsDialog(content::WebContents* initiator) {
  return WindowRegistry::Get().HoldsTab(initiator);
}

bool HandleDialog(content::WebContents* initiator,
                  media_router::MediaRouterUI* ui) {
  if (!ui || !WantsDialog(initiator))
    return false;
  auto dialog = std::make_unique<Dialog>(initiator, ui);
  const int id = dialog->id();
  Live()[id] = std::move(dialog);
  // Not from inside Chrome's dialog creation: the app may answer at once.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](int id) {
                       if (Dialog* dialog = Find(id))
                         dialog->Start();
                     },
                     id));
  return true;
}

}  // namespace

// static
void CastDialogs::Start(Sink sink) {
  EventSink() = std::move(sink);
  g_bay_wants_cast_dialog = &WantsDialog;
  g_bay_cast_dialog = &HandleDialog;
}

// static
bool CastDialogs::StartCasting(int id, const std::string& sink, int cast_mode) {
  using media_router::MediaCastMode;
  switch (static_cast<MediaCastMode>(cast_mode)) {
    case MediaCastMode::PRESENTATION:
    case MediaCastMode::TAB_MIRROR:
    case MediaCastMode::DESKTOP_MIRROR:
    case MediaCastMode::REMOTE_PLAYBACK:
      break;
    default:
      return false;
  }
  if (Dialog* dialog = Find(id))
    dialog->StartCasting(sink, static_cast<MediaCastMode>(cast_mode));
  return true;
}

// static
void CastDialogs::StopCasting(int id, const std::string& route) {
  if (Dialog* dialog = Find(id))
    dialog->StopCasting(route);
}

// static
void CastDialogs::Close(int id) {
  if (Dialog* dialog = Find(id))
    dialog->Close();
}

// static
base::DictValue CastDialogs::DescribeSink(
    const media_router::UIMediaSink& sink) {
  int modes = 0;
  for (auto mode : sink.cast_modes)
    modes |= static_cast<int>(mode);
  return base::DictValue()
      .Set("id", sink.id)
      .Set("name", sink.friendly_name)
      .Set("status", sink.GetStatusTextForDisplay())
      .Set("state", SinkState(sink.state))
      .Set("icon", static_cast<int>(sink.icon_type))
      .Set("modes", modes)
      .Set("routeId", sink.route ? sink.route->media_route_id() : std::string())
      .Set("issue", sink.issue ? sink.issue->info().title : std::string());
}

}  // namespace bay
