// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/app_runtime.h"

#include <cmath>
#include <utility>
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/timer/timer.h"
#include "base/uuid.h"
#include "chrome/browser/bay/webui/bay_webui.h"
#include "chrome/browser/bay/webui/native_host.h"
#include "chrome/browser/bay/webui/native_host.mojom.h"
#include "chrome/browser/bay/webui/runtime_state.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/keep_alive/profile_keep_alive_types.h"
#include "chrome/browser/profiles/keep_alive/scoped_profile_keep_alive.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/document_service.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "ui/base/base_window.h"
#include "ui/base/page_transition_types.h"

namespace bay {
namespace {
constexpr size_t kMaximumCommitBytes = 16 * 1024 * 1024;
constexpr size_t kMaximumRequestBytes = 1024 * 1024;
constexpr size_t kMaximumPending = 64;
std::unique_ptr<AppRuntime>& Instance() {
  static base::NoDestructor<std::unique_ptr<AppRuntime>> instance;
  return *instance;
}
std::string ID() {
  return base::Uuid::GenerateRandomV4().AsLowercaseString();
}
std::string Json(base::DictValue value) {
  return base::WriteJson(value).value_or("{}");
}
std::string Success(base::Value value = base::Value()) {
  return Json(base::DictValue().Set("value", std::move(value)));
}
std::string Failure(const char* code, const char* message) {
  return Json(base::DictValue().Set(
      "error", base::DictValue().Set("code", code).Set("message", message)));
}
std::optional<base::DictValue> Parse(const std::string& value, size_t maximum) {
  if (value.size() > maximum)
    return std::nullopt;
  return base::JSONReader::ReadDict(value, base::JSON_PARSE_RFC);
}
}  // namespace

class RuntimeConnection final
    : public content::DocumentService<mojom::AppRuntime> {
 public:
  RuntimeConnection(content::RenderFrameHost& frame,
                    base::WeakPtr<bay::AppRuntime> runtime,
                    BrowserWindowInterface* window,
                    mojo::PendingReceiver<mojom::AppRuntime> receiver)
      : DocumentService(frame, std::move(receiver)),
        runtime_(runtime),
        window_(window ? window->GetWeakPtr()
                       : base::WeakPtr<BrowserWindowInterface>()),
        is_coordinator_(
            runtime->Owns(content::WebContents::FromRenderFrameHost(&frame))),
        id_(ID()) {}
  ~RuntimeConnection() override {
    if (runtime_)
      runtime_->ConnectionClosed(this);
  }
  void Connect(mojo::PendingRemote<mojom::AppRuntimeClient> client,
               ConnectCallback callback) override {
    if (!runtime_ || runtime_->shutdown_ || connected_) {
      std::move(callback).Run(
          Failure("closed", "Runtime connection is unavailable"));
      return;
    }
    const std::string window_id =
        window_ ? WindowRegistry::Get().IdFor(window_.get()) : "";
    if (!is_coordinator_ && window_id.empty()) {
      std::move(callback).Run(
          Failure("not_ready", "Native window has no canonical id"));
      return;
    }
    if (is_coordinator_ && runtime_->coordinator_) {
      std::move(callback).Run(
          Failure("already_connected", "Coordinator is already connected"));
      return;
    }
    connected_ = true;
    client_.Bind(std::move(client));
    client_.set_disconnect_handler(base::BindOnce(
        &RuntimeConnection::Disconnected, weak_factory_.GetWeakPtr()));
    runtime_->connections_[id_] = weak_factory_.GetWeakPtr();
    base::DictValue info;
    info.Set("version", 1);
    info.Set("role", is_coordinator_ ? "coordinator" : "window");
    info.Set("epoch", runtime_->epoch_);
    info.Set("clientId", id_);
    if (is_coordinator_) {
      runtime_->coordinator_ = weak_factory_.GetWeakPtr();
      if (runtime_->accepted_)
        info.Set("recoveryState",
                 runtime_->accepted_->FindDict("state")->Clone());
    } else {
      info.Set("windowId", window_id);
    }
    std::move(callback).Run(Success(base::Value(std::move(info))));
  }
  void GetSnapshot(GetSnapshotCallback callback) override {
    auto snapshot = runtime_ && client_.is_bound() ? runtime_->Snapshot(*this)
                                                   : std::nullopt;
    std::move(callback).Run(
        snapshot ? Success(base::Value(std::move(*snapshot)))
                 : Failure("not_ready", "Application state is not ready"));
  }
  void Dispatch(const std::string& request_json,
                DispatchCallback callback) override {
    auto request = Parse(request_json, kMaximumRequestBytes);
    if (!runtime_ || !client_.is_bound() || is_coordinator_ ||
        !runtime_->ready_ || !runtime_->coordinator_ || !runtime_->accepted_) {
      std::move(callback).Run(
          Failure("not_ready", "Application coordinator is not ready"));
      return;
    }
    const auto status = request
                            ? ValidateRuntimeRequest(*request, runtime_->epoch_,
                                                     last_request_id_)
                            : RuntimeRequestStatus::kInvalid;
    if (status != RuntimeRequestStatus::kAccepted) {
      const char* code =
          status == RuntimeRequestStatus::kStaleEpoch ? "stale_epoch"
          : status == RuntimeRequestStatus::kExpired  ? "request_expired"
                                                      : "invalid_request";
      std::move(callback).Run(Failure(
          code, "Command was not accepted; mutations must not be retried"));
      return;
    }
    const auto request_id = RuntimeInteger(*request, "requestId");
    const auto* command = request->FindDict("command");
    const std::string window_id =
        window_ ? WindowRegistry::Get().IdFor(window_.get()) : "";
    if (!CanDispatchRuntimeCommand(*runtime_->accepted_->FindDict("state"),
                                   window_id, *command)) {
      std::move(callback).Run(
          Failure("forbidden", "Command does not belong to this window"));
      return;
    }
    if (runtime_->pending_.size() >= kMaximumPending) {
      std::move(callback).Run(
          Failure("busy", "Too many pending browser commands"));
      return;
    }
    last_request_id_ = *request_id;
    request->Set("clientId", id_);
    const auto token = ID();
    runtime_->Queue(*this, token, *request_id,
                    *command->FindString("method") == "newTab",
                    std::move(callback));
    runtime_->coordinator_->client_->OnCommand(token,
                                               Json(std::move(*request)));
  }
  void Publish(const std::string& commit_json,
               PublishCallback callback) override {
    if (!Authorized()) {
      std::move(callback).Run(
          Failure("forbidden", "Only the owned coordinator can publish"));
      return;
    }
    auto commit = Parse(commit_json, kMaximumCommitBytes);
    // A recovered coordinator starts a new epoch at revision zero.
    const double next =
        runtime_->accepted_ && runtime_->accepted_->FindString("epoch") &&
                *runtime_->accepted_->FindString("epoch") == runtime_->epoch_
            ? *RuntimeInteger(*runtime_->accepted_, "revision") + 1
            : 0;
    if (!commit || !IsRuntimeCommit(*commit, runtime_->epoch_, next)) {
      std::move(callback).Run(Failure(
          "invalid_commit", "Expected the next complete application state"));
      return;
    }
    runtime_->accepted_ = std::move(*commit);
    if (runtime_->ready_) {
      for (const auto& [id, connection] : runtime_->connections_) {
        if (!connection || connection->is_coordinator_)
          continue;
        auto projection = runtime_->Snapshot(*connection);
        if (projection)
          connection->client_->OnCommit(Json(std::move(*projection)));
      }
    }
    std::move(callback).Run(Success());
  }
  void Resolve(const std::string& token,
               const std::string& reply_json,
               ResolveCallback callback) override;
  void Ready(ReadyCallback callback) override {
    if (!Authorized() || !runtime_->accepted_ ||
        *runtime_->accepted_->FindString("epoch") != runtime_->epoch_) {
      std::move(callback).Run(
          Failure("not_ready", "Coordinator has not published state"));
      return;
    }
    const auto* windows =
        runtime_->accepted_->FindDict("state")->FindDict("windows");
    if (windows->empty()) {
      std::move(callback).Run(
          Failure("not_ready", "Application has no canonical native window"));
      return;
    }
    for (const auto [id, state] : *windows) {
      if (!WindowRegistry::Get().Find(std::string(id))) {
        std::move(callback).Run(
            Failure("not_ready", "Native window reconciliation is incomplete"));
        return;
      }
    }
    runtime_->ready_ = true;
    runtime_->RetireUnusedStartupWindow();
    std::move(callback).Run(Success());
  }
  bool Authorized() const {
    return runtime_ && client_.is_bound() && is_coordinator_ &&
           runtime_->coordinator_.get() == this;
  }

 private:
  friend class bay::AppRuntime;
  void Disconnected() {
    if (runtime_)
      runtime_->ConnectionClosed(this);
    client_.reset();
  }
  base::WeakPtr<bay::AppRuntime> runtime_;
  base::WeakPtr<BrowserWindowInterface> window_;
  const bool is_coordinator_;
  const std::string id_;
  bool connected_ = false;
  double last_request_id_ = 0;
  mojo::Remote<mojom::AppRuntimeClient> client_;
  base::WeakPtrFactory<RuntimeConnection> weak_factory_{this};
};

struct AppRuntime::Pending {
  base::WeakPtr<RuntimeConnection> connection;
  double request_id = 0;
  double minimum_revision = 0;
  bool creates_id = false;
  mojom::AppRuntime::DispatchCallback callback;
  base::OneShotTimer deadline;
};

void RuntimeConnection::Resolve(const std::string& token,
                                const std::string& reply_json,
                                ResolveCallback callback) {
  if (!Authorized()) {
    std::move(callback).Run(Failure(
        "forbidden", "Only the owned coordinator can resolve commands"));
    return;
  }
  const auto found = runtime_->pending_.find(token);
  if (found == runtime_->pending_.end()) {
    std::move(callback).Run(
        Failure("unknown_command", "Command expired or disconnected"));
    return;
  }
  auto reply = Parse(reply_json, kMaximumRequestBytes);
  const auto accepted_revision =
      runtime_->accepted_ ? RuntimeInteger(*runtime_->accepted_, "revision")
                          : std::nullopt;
  if (!reply || !accepted_revision ||
      !IsRuntimeReply(*reply, runtime_->epoch_, found->second->minimum_revision,
                      *accepted_revision, found->second->creates_id)) {
    std::move(callback).Run(Failure(
        "invalid_reply",
        "Command reply precedes its accepted commit or has an invalid result"));
    return;
  }
  const auto* error = reply->FindDict("error");
  const auto* value = reply->Find("value");
  auto pending = std::move(found->second);
  runtime_->pending_.erase(found);
  auto projection = pending->connection
                        ? runtime_->Snapshot(*pending->connection)
                        : std::nullopt;
  if (error) {
    std::move(pending->callback)
        .Run(Json(base::DictValue().Set("error", error->Clone())));
  } else if (!projection || !pending->connection) {
    std::move(pending->callback)
        .Run(Failure("closed", "Command owner is no longer available"));
  } else {
    base::DictValue result;
    result.Set("clientId", pending->connection->id_);
    result.Set("requestId", pending->request_id);
    result.Set("commit", std::move(*projection));
    result.Set("value", value->Clone());
    std::move(pending->callback).Run(Success(base::Value(std::move(result))));
  }
  std::move(callback).Run(Success());
}

bool AppRuntime::Enabled() {
  const auto* command = base::CommandLine::ForCurrentProcess();
  return command->HasSwitch("bay-shared-runtime") &&
         !command->HasSwitch("bay-hosting-spike");
}
AppRuntime* AppRuntime::GetIfStarted() {
  return Instance().get();
}
void AppRuntime::StartForWindow(BrowserWindowInterface& window) {
  if (!Enabled() || Instance())
    return;
  Instance() = std::unique_ptr<AppRuntime>(new AppRuntime(window));
  Instance()->Start();
}
void AppRuntime::ShutdownIfStarted() {
  if (Instance()) {
    Instance()->Shutdown();
    Instance().reset();
  }
}
AppRuntime::AppRuntime(BrowserWindowInterface& window)
    : startup_window_(window.GetWeakPtr()), epoch_(ID()) {}
AppRuntime::~AppRuntime() {
  Shutdown();
}
void AppRuntime::Start() {
  auto* manager =
      g_browser_process ? g_browser_process->profile_manager() : nullptr;
  base::FilePath directory;
  if (!manager || !base::PathService::Get(chrome::DIR_USER_DATA, &directory)) {
    Shutdown();
    return;
  }
  profile_observation_.Observe(manager);
  // Never run the application coordinator in whichever named/private profile
  // happened to create the first shell.
  manager->CreateProfileAsync(
      directory.AppendASCII("Default"),
      base::BindOnce(&AppRuntime::ProfileLoaded, weak_factory_.GetWeakPtr()));
}
void AppRuntime::ProfileLoaded(Profile* profile) {
  if (shutdown_ || !profile || profile->IsOffTheRecord()) {
    Shutdown();
    return;
  }
  profile_keep_alive_ = ScopedProfileKeepAlive::TryAcquire(
      profile, ProfileKeepAliveOrigin::kAppWindow);
  if (!profile_keep_alive_) {
    Shutdown();
    return;
  }
  content::WebContents::CreateParams params(profile);
  params.initially_hidden = true;
  contents_ = content::WebContents::Create(params);
  Observe(contents_.get());
  coordinator_document_live_ = true;
  contents_->GetController().LoadURL(GURL(kBayURL), content::Referrer(),
                                     ui::PAGE_TRANSITION_AUTO_TOPLEVEL, {});
}
bool AppRuntime::Owns(content::WebContents* contents) const {
  return !shutdown_ && contents && contents_.get() == contents;
}
Profile* AppRuntime::profile() const {
  return profile_keep_alive_ ? profile_keep_alive_->profile() : nullptr;
}
BrowserWindowInterface* AppRuntime::TakeStartupWindowForAdoption(
    Profile* profile) {
  auto* startup = startup_window_.get();
  if (!startup || startup->GetProfile() != profile ||
      !WindowRegistry::Get().IdFor(startup).empty())
    return nullptr;
  startup_window_.reset();
  return startup;
}
void AppRuntime::RetireUnusedStartupWindow() {
  if (!startup_window_ ||
      !WindowRegistry::Get().IdFor(startup_window_.get()).empty())
    return;
  // Ready follows canonical native-window reconciliation. Do not discard the
  // initial shell while it is still the only usable window.
  for (const auto& value : WindowRegistry::Get().Ids()) {
    auto* replacement = WindowRegistry::Get().Find(value.GetString());
    if (replacement && replacement != startup_window_.get()) {
      retiring_startup_window_ = startup_window_;
      startup_window_.reset();
      retiring_startup_window_->GetWindow()->Close();
      return;
    }
  }
}
bool AppRuntime::IsRetiringStartupWindow(BrowserWindowInterface* window) const {
  return window && retiring_startup_window_.get() == window;
}
void AppRuntime::SetCoordinatorHost(base::WeakPtr<NativeHost> host) {
  coordinator_host_ = std::move(host);
}
base::WeakPtr<NativeHost> AppRuntime::coordinator_host() const {
  return coordinator_host_;
}
void AppRuntime::Bind(content::WebUI* web_ui,
                      mojo::PendingReceiver<mojom::AppRuntime> receiver) {
  if (shutdown_ || connections_.size() >= 128)
    return;
  auto* contents = web_ui->GetWebContents();
  auto* frame = contents->GetPrimaryMainFrame();
  auto* window = WebUIBrowserWindow::FromWebShellWebContents(contents);
  if (!frame || frame->GetLastCommittedURL() != GURL(kBayURL) ||
      (!Owns(contents) && !window))
    return;
  auto* connection = new RuntimeConnection(*frame, weak_factory_.GetWeakPtr(),
                                           window ? window->browser() : nullptr,
                                           std::move(receiver));
  connections_[connection->id_] = connection->weak_factory_.GetWeakPtr();
}
void AppRuntime::Queue(RuntimeConnection& connection,
                       const std::string& token,
                       double request_id,
                       bool creates_id,
                       mojom::AppRuntime::DispatchCallback callback) {
  auto pending = std::make_unique<Pending>();
  pending->connection = connection.weak_factory_.GetWeakPtr();
  pending->request_id = request_id;
  pending->creates_id = creates_id;
  pending->minimum_revision = *RuntimeInteger(*accepted_, "revision");
  pending->callback = std::move(callback);
  pending->deadline.Start(
      FROM_HERE, base::Seconds(30),
      base::BindOnce(&AppRuntime::Timeout, weak_factory_.GetWeakPtr(), token));
  pending_.emplace(token, std::move(pending));
}
void AppRuntime::Timeout(const std::string& token) {
  const auto found = pending_.find(token);
  if (found == pending_.end())
    return;
  auto pending = std::move(found->second);
  pending_.erase(found);
  std::move(pending->callback)
      .Run(Failure("command_timeout",
                   "Command outcome is uncertain; do not retry"));
}
std::optional<base::DictValue> AppRuntime::Snapshot(
    RuntimeConnection& connection) const {
  if (!ready_ || !accepted_ || !connection.client_.is_bound())
    return std::nullopt;
  if (connection.is_coordinator_)
    return accepted_->Clone();
  const auto id = connection.window_
                      ? WindowRegistry::Get().IdFor(connection.window_.get())
                      : "";
  auto projection = ProjectRuntimeState(*accepted_->FindDict("state"), id);
  if (!projection)
    return std::nullopt;
  auto snapshot = accepted_->Clone();
  snapshot.Set("state", std::move(*projection));
  return snapshot;
}
void AppRuntime::FailPending(const char* code) {
  auto pending = std::exchange(pending_, {});
  for (auto& [token, operation] : pending)
    std::move(operation->callback)
        .Run(Failure(code, "Command outcome is uncertain; do not retry"));
}
void AppRuntime::ConnectionClosed(RuntimeConnection* connection) {
  if (!connections_.erase(connection->id_))
    return;
  if (coordinator_.get() == connection) {
    CoordinatorClosed();
    return;
  }
  std::vector<std::string> remove;
  for (const auto& [token, pending] : pending_)
    if (pending->connection.get() == connection)
      remove.push_back(token);
  for (const auto& token : remove)
    Timeout(token);
}
void AppRuntime::CoordinatorClosed() {
  if (shutdown_ || !std::exchange(coordinator_document_live_, false))
    return;
  ready_ = false;
  coordinator_.reset();
  coordinator_host_.reset();
  FailPending("new_epoch");
  epoch_ = ID();
  for (const auto& [id, connection] : connections_)
    if (connection && connection->client_.is_bound())
      connection->client_->OnRuntimeClosed("new_epoch");
  // A replacement document receives only accepted state under the new epoch.
  // Pending mutations are never replayed. Repeated crashes stop the runtime
  // instead of spinning a hidden renderer indefinitely.
  const auto now = base::TimeTicks::Now();
  while (!restart_times_.empty() &&
         now - restart_times_.front() > base::Seconds(30))
    restart_times_.pop_front();
  if (restart_times_.size() >= 3) {
    restart_.Start(
        FROM_HERE, base::Milliseconds(100),
        base::BindOnce(&AppRuntime::Shutdown, weak_factory_.GetWeakPtr()));
    return;
  }
  restart_times_.push_back(now);
  restart_.Start(FROM_HERE, base::Milliseconds(100),
                 base::BindOnce(&AppRuntime::RestartCoordinator,
                                weak_factory_.GetWeakPtr()));
}
void AppRuntime::RestartCoordinator() {
  if (shutdown_ || !contents_)
    return;
  coordinator_document_live_ = true;
  contents_->GetController().LoadURL(GURL(kBayURL), content::Referrer(),
                                     ui::PAGE_TRANSITION_AUTO_TOPLEVEL, {});
}
void AppRuntime::PrimaryMainFrameRenderProcessGone(base::TerminationStatus) {
  CoordinatorClosed();
}
void AppRuntime::OnProfileManagerDestroying() {
  Shutdown();
}
void AppRuntime::Shutdown() {
  if (std::exchange(shutdown_, true))
    return;
  ready_ = false;
  restart_.Stop();
  FailPending("closed");
  for (const auto& [id, connection] : connections_)
    if (connection && connection->client_.is_bound())
      connection->client_->OnRuntimeClosed("closed");
  weak_factory_.InvalidateWeakPtrs();
  connections_.clear();
  coordinator_.reset();
  coordinator_host_.reset();
  Observe(nullptr);
  contents_.reset();
  profile_keep_alive_.reset();
  profile_observation_.Reset();
}
void ShutdownAppRuntimeIfStarted() {
  AppRuntime::ShutdownIfStarted();
}
void BindAppRuntime(content::WebUI* web_ui,
                    mojo::PendingReceiver<mojom::AppRuntime> receiver) {
  if (!AppRuntime::Enabled())
    return;
  if (auto* runtime = AppRuntime::GetIfStarted())
    runtime->Bind(web_ui, std::move(receiver));
}
}  // namespace bay
