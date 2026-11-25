// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_cast_dialogs.h"

#include <map>
#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/ui/media_router/cast_dialog_controller.h"
#include "chrome/browser/ui/media_router/cast_dialog_model.h"
#include "chrome/browser/ui/media_router/media_cast_mode.h"
#include "chrome/browser/ui/media_router/media_router_ui.h"
#include "chrome/browser/ui/media_router/ui_media_sink.h"
#include "components/media_router/browser/media_router_dialog_controller.h"
#include "content/public/browser/web_contents.h"

namespace nncore::cast {
namespace {

Tell& Teller() {
  static base::NoDestructor<Tell> tell;
  return *tell;
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
    if (ui_) {
      ui_->AddObserver(this);
    }
    announced_ = true;
    Notify();
  }

  void StartCasting(const std::string& sink, media_router::MediaCastMode mode) {
    if (ui_) {
      ui_->StartCasting(sink, mode);
    }
  }

  void StopCasting(const std::string& route) {
    if (ui_) {
      ui_->StopCasting(route);
    }
  }

  void Close() {
    if (!open_) {
      return;
    }
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
    for (const auto& sink : model.media_sinks()) {
      sinks_.Append(DescribeSink(sink));
    }
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
  base::DictValue State() const {
    return base::DictValue()
        .Set("id", id_)
        .Set("open", open_)
        .Set("header", header_)
        .Set("permissionRejected", permission_rejected_)
        .Set("castingStarted", casting_started_)
        .Set("sinks", sinks_.Clone());
  }

  void Notify() {
    if (!announced_ || !initiator_ || !Teller()) {
      return;
    }
    const bool told = Teller().Run(initiator_.get(), State());
    // Not from inside the model's own call.
    if (!told && open_) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&cast::Close, id_));
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

}  // namespace

void SetTell(Tell tell) {
  Teller() = std::move(tell);
}

void Adopt(content::WebContents* initiator, media_router::MediaRouterUI* ui) {
  auto dialog = std::make_unique<Dialog>(initiator, ui);
  const int id = dialog->id();
  Live()[id] = std::move(dialog);
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](int id) {
                       if (Dialog* dialog = Find(id)) {
                         dialog->Start();
                       }
                     },
                     id));
}

bool StartCasting(int id, const std::string& sink, int cast_mode) {
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
  if (Dialog* dialog = Find(id)) {
    dialog->StartCasting(sink, static_cast<MediaCastMode>(cast_mode));
  }
  return true;
}

void StopCasting(int id, const std::string& route) {
  if (Dialog* dialog = Find(id)) {
    dialog->StopCasting(route);
  }
}

void Close(int id) {
  if (Dialog* dialog = Find(id)) {
    dialog->Close();
  }
}

base::DictValue DescribeSink(const media_router::UIMediaSink& sink) {
  int modes = 0;
  for (auto mode : sink.cast_modes) {
    modes |= static_cast<int>(mode);
  }
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

}  // namespace nncore::cast
