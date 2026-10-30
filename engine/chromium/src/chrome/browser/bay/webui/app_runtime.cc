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
#include "base/task/single_thread_task_runner.h"
#include "base/timer/timer.h"
#include "base/uuid.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/bay_webui.h"
#include "chrome/browser/bay/webui/native_host.h"
#include "chrome/browser/bay/webui/native_host.mojom.h"
#include "chrome/browser/bay/webui/runtime_state.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/keep_alive/profile_keep_alive_types.h"
#include "chrome/browser/profiles/keep_alive/scoped_profile_keep_alive.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/common/chrome_paths.h"
#include "chrome/common/webui_url_constants.h"
#include "content/public/browser/document_service.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/common/url_constants.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "ui/base/base_window.h"
#include "ui/base/page_transition_types.h"

namespace bay {
namespace {
constexpr size_t kMaximumCommitBytes = 16 * 1024 * 1024;
constexpr size_t kMaximumRequestBytes = 1024 * 1024;
constexpr size_t kMaximumPending = 64;
// The coordinator names a regular Chrome profile by its directory, the default
// one by "".
std::string RegularProfileId(Profile* profile) {
  const auto name =
      profile->GetOriginalProfile()->GetPath().BaseName().AsUTF8Unsafe();
  return name == "Default" ? "" : name;
}
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
    if (!CanDispatchRuntimeCommand(
            *runtime_->accepted_->FindDict("state"), window_id, *command,
            WindowRegistry::Get().IsUtility(window_.get()))) {
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
    if (!window_id.empty())
      request->Set("originWindowId", window_id);
    const auto token = ID();
    runtime_->Queue(*this, token, *request_id,
                    RuntimeCommandResultKind(*command), std::move(callback));
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
    if (!runtime_->ValidatePageOpens(*commit->FindDict("state"))) {
      std::move(callback).Run(Failure(
          "invalid_commit", "Page adoption does not match its native offer"));
      return;
    }
    // Park live pages before either renderer sees ownership change. A source
    // unmount or native window close may otherwise destroy the destination page.
    TabBroker::Get().PreserveTransfers(
        runtime_->accepted_ ? runtime_->accepted_->FindDict("state") : nullptr,
        *commit->FindDict("state"));
    runtime_->accepted_ = std::move(*commit);
    runtime_->ReconcilePageOpens();
    runtime_->page_events_.Prune(*runtime_->accepted_->FindDict("state"));
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
  RuntimeResultKind result_kind = RuntimeResultKind::kNone;
  mojom::AppRuntime::DispatchCallback callback;
  base::OneShotTimer deadline;
};

struct AppRuntime::PageOpen {
  base::WeakPtr<content::WebContents> contents;
  base::WeakPtr<Profile> profile;
  base::DictValue event;
  std::optional<RuntimePageOpenTarget> target;
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
                      *accepted_revision, found->second->result_kind)) {
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
  if (command->HasSwitch("bay-legacy-runtime") ||
      command->HasSwitch("bay-hosting-spike"))
    return false;
#if BUILDFLAG(IS_WIN)
  return true;
#else
  return command->HasSwitch("bay-shared-runtime");
#endif
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
  page_events_started_ = false;
  coordinator_host_ = std::move(host);
}
base::WeakPtr<NativeHost> AppRuntime::coordinator_host() const {
  return coordinator_host_;
}
bool AppRuntime::CanMountPage(const std::string& window_id,
                              const std::string& tab_id,
                              const std::string& profile,
                              const std::string& adopt_id) const {
  return !shutdown_ && accepted_ &&
         CanMountRuntimePage(*accepted_->FindDict("state"), window_id, tab_id,
                             profile) &&
         CanMountRuntimePageOffer(*accepted_->FindDict("state"), tab_id,
                                  adopt_id);
}
bool AppRuntime::StartPageEvents(NativeHost* host) {
  if (shutdown_ || !host || coordinator_host_.get() != host || !coordinator_ ||
      !coordinator_->Authorized() || !accepted_)
    return false;
  if (std::exchange(page_events_started_, true))
    return true;
  ReconcilePageOpens();
  for (auto& event : page_events_.Replay(*accepted_->FindDict("state")))
    host->Emit("BayCEF", "onPageEvent", base::Value(std::move(event)));
  for (const auto& [id, opened] : page_opens_)
    host->Emit("BayCEF", "onPageOpen", base::Value(opened->event.Clone()));
  return true;
}
bool AppRuntime::StopPageEvents(NativeHost* host) {
  if (!host || coordinator_host_.get() != host)
    return false;
  page_events_started_ = false;
  return true;
}
void AppRuntime::PageEvent(const std::string& tab_id,
                           const std::string& profile,
                           int browser_id,
                           const char* event,
                           base::DictValue payload) {
  if (shutdown_ || !accepted_)
    return;
  auto fact =
      page_events_.Record(*accepted_->FindDict("state"), tab_id, profile,
                          browser_id, event, std::move(payload));
  if (fact && page_events_started_ && coordinator_host_)
    coordinator_host_->Emit("BayCEF", "onPageEvent",
                            base::Value(std::move(*fact)));
}
void AppRuntime::ForgetPage(const std::string& tab_id) {
  page_events_.Remove(tab_id);
}
void AppRuntime::OpenPage(content::WebContents* source,
                          content::WebContents* opened,
                          const std::string& source_tab_id,
                          const std::string& source_window_id,
                          const GURL& url,
                          WindowOpenDisposition disposition) {
  if (shutdown_ || !accepted_ || !source || !opened || source == opened ||
      !url.is_valid() || url.SchemeIs("javascript") || url.SchemeIs("bay") ||
      url.spec().size() > kMaximumRequestBytes)
    return;
  ReconcilePageOpens();
  if (page_opens_.size() >= kMaximumPending)
    return;
  auto* source_profile = Profile::FromBrowserContext(source->GetBrowserContext());
  auto* opened_profile = Profile::FromBrowserContext(opened->GetBrowserContext());
  if (opened_profile->GetOriginalProfile() != source_profile->GetOriginalProfile())
    return;
  std::string window_id = source_window_id;
  if (auto* browser = GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(source))
    window_id = WindowRegistry::Get().IdFor(browser);
  const auto& state = *accepted_->FindDict("state");
  const auto* tab = state.FindDict("tabs")->FindDict(source_tab_id);
  if (!source_tab_id.empty()) {
    const auto* owner = tab ? tab->FindString("windowId") : nullptr;
    if (window_id.empty() && owner)
      window_id = *owner;
  }
  const std::string regular_profile = RegularProfileId(source_profile);
  const std::string profile = source_profile->IsOffTheRecord()
                                  ? "incognito:" + window_id
                                  : regular_profile;
  const auto* window = state.FindDict("windows")->FindDict(window_id);
  if (!window || window_id.empty() ||
      window->FindBool("incognito").value_or(false) != source_profile->IsOffTheRecord() ||
      (!source_tab_id.empty() && !CanAcceptRuntimePageEvent(state, source_tab_id, profile)))
    return;
  const char* intent = nullptr;
  switch (disposition) {
    // Current-tab navigation already belongs to the source WebContents. A
    // separate offered page cannot replace that tab's broker identity.
    case WindowOpenDisposition::CURRENT_TAB: return;
    case WindowOpenDisposition::NEW_BACKGROUND_TAB: intent = "background"; break;
    case WindowOpenDisposition::NEW_WINDOW:
    case WindowOpenDisposition::NEW_POPUP: intent = "window"; break;
    case WindowOpenDisposition::OFF_THE_RECORD: intent = "incognito"; break;
    case WindowOpenDisposition::NEW_SPLIT_VIEW: intent = "split"; break;
    case WindowOpenDisposition::NEW_FOREGROUND_TAB:
    case WindowOpenDisposition::SINGLETON_TAB:
    case WindowOpenDisposition::SWITCH_TO_TAB: intent = "foreground"; break;
    default: return;
  }
  base::DictValue event;
  event.Set("sourceWindowId", window_id);
  if (!source_tab_id.empty())
    event.Set("sourceTabId", source_tab_id);
  event.Set("sourceProfile", profile);
  event.Set("profile", source_profile->IsOffTheRecord() &&
                               source_profile == opened_profile
                           ? profile : regular_profile);
  event.Set("incognito", opened_profile->IsOffTheRecord());
  event.Set("url", url.spec());
  event.Set("disposition", intent);
  // Chrome is still attaching the newly created TabModel during this callback.
  // Detach only after its open/navigation stack has completely unwound.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&AppRuntime::OfferPage,
                               weak_factory_.GetWeakPtr(), opened->GetWeakPtr(),
                               opened_profile->GetWeakPtr(), std::move(event)));
}
void AppRuntime::AdoptPage(content::WebContents* contents,
                           const std::string& window_id,
                           bool foreground) {
  if (shutdown_ || !accepted_ || !contents)
    return;
  auto* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  const GURL& url = contents->GetVisibleURL();
  const auto* window =
      accepted_->FindDict("state")->FindDict("windows")->FindDict(window_id);
  if (profile->IsOffTheRecord() || !window ||
      window->FindBool("incognito").value_or(false) || !url.is_valid() ||
      url.IsAboutBlank() || url.SchemeIs("javascript") || url.SchemeIs("bay") ||
      (url.SchemeIs(content::kChromeUIScheme) &&
       url.host() == chrome::kChromeUINewTabHost) ||
      url.spec().size() > kMaximumRequestBytes)
    return;
  ReconcilePageOpens();
  if (page_opens_.size() >= kMaximumPending)
    return;
  const std::string regular_profile = RegularProfileId(profile);
  base::DictValue event;
  event.Set("sourceWindowId", window_id);
  event.Set("sourceProfile", regular_profile);
  event.Set("profile", regular_profile);
  event.Set("incognito", false);
  event.Set("url", url.spec());
  event.Set("disposition", foreground ? "foreground" : "background");
  // The caller's stack has unwound: park the page now, before its window closes.
  OfferPage(contents->GetWeakPtr(), profile->GetWeakPtr(), std::move(event));
}
void AppRuntime::OfferPage(base::WeakPtr<content::WebContents> contents,
                           base::WeakPtr<Profile> profile,
                           base::DictValue event) {
  if (shutdown_ || !contents || !profile ||
      page_opens_.size() >= kMaximumPending ||
      contents->GetBrowserContext() != profile.get())
    return;
  // Chrome destroys a primary OTR profile when its last browser closes. Keep
  // this page attached until its destination browser exists; Mount then moves
  // it without leaving that exact profile temporarily without a browser.
  auto offered = TabBroker::Get().Offer(contents.get(), !profile->IsIncognitoProfile());
  if (!offered.error.empty() || page_opens_.contains(offered.adopt_id))
    return;
  event.Set("offerId", offered.adopt_id);
  auto opened = std::make_unique<PageOpen>();
  opened->contents = contents;
  opened->profile = profile;
  opened->event = std::move(event);
  auto* pending = opened.get();
  page_opens_[offered.adopt_id] = std::move(opened);
  if (page_events_started_ && coordinator_host_)
    coordinator_host_->Emit("BayCEF", "onPageOpen", base::Value(pending->event.Clone()));
}
bool AppRuntime::ValidatePageOpens(const base::DictValue& state) const {
  std::map<std::string, Profile*> profiles;
  for (const auto& [id, opened] : page_opens_) {
    bool named = false;
    for (const auto [tab_id, value] : *state.FindDict("tabs")) {
      const auto& tab = value.GetDict();
      for (const char* field : {"adoptId", "wakeAdoptId"}) {
        const auto* token = tab.FindString(field);
        named |= token && *token == id;
      }
    }
    if (!named)
      continue;
    if (!opened->profile || !opened->contents)
      return false;
    const auto* profile = opened->event.FindString("profile");
    auto target = FindRuntimePageOpenTarget(state, id, *profile,
                                            opened->profile->IsOffTheRecord());
    if (!target)
      return false;
    if (opened->target &&
        (opened->target->tab_id != target->tab_id ||
         opened->target->profile != target->profile))
      return false;
    if (const auto* source = opened->event.FindString("sourceProfile");
        source && source->starts_with("incognito:") &&
        target->profile != *source)
      return false;
    // A regular window holds a Browser for each regular profile it shows
    // (WindowRegistry::BrowserFor); a private window holds only its own.
    const bool private_page = opened->profile->IsOffTheRecord();
    if (auto* window = WindowRegistry::Get().Find(target->window_id);
        window && window->GetProfile() != opened->profile.get() &&
        (private_page || window->GetProfile()->IsOffTheRecord()))
      return false;
    if (!private_page)
      continue;
    const auto [existing, inserted] =
        profiles.emplace(target->window_id, opened->profile.get());
    if (!inserted && existing->second != opened->profile.get())
      return false;
  }
  return true;
}
void AppRuntime::ReconcilePageOpens() {
  std::vector<std::string> release;
  const auto& state = *accepted_->FindDict("state");
  for (const auto& [id, opened] : page_opens_) {
    if (!opened->contents || !opened->profile) {
      release.push_back(id);
      continue;
    }
    auto target = FindRuntimePageOpenTarget(
        state, id, *opened->event.FindString("profile"),
        opened->profile->IsOffTheRecord());
    if (target) {
      opened->target = std::move(target);
    } else {
      const auto* source_tab = opened->event.FindString("sourceTabId");
      const bool source_exists = source_tab
          ? CanAcceptRuntimePageEvent(state, *source_tab,
                                      *opened->event.FindString("sourceProfile"))
          : state.FindDict("windows")->contains(
                *opened->event.FindString("sourceWindowId"));
      if (opened->target || !source_exists)
        release.push_back(id);
    }
  }
  for (const auto& id : release)
    ReleasePageOpen(id);
}
bool AppRuntime::FinishPageOpen(NativeHost* host,
                                const std::string& offer_id,
                                const std::string* target_tab_id) {
  if (shutdown_ || coordinator_host_.get() != host || !coordinator_ ||
      !coordinator_->Authorized())
    return false;
  const auto found = page_opens_.find(offer_id);
  if (found == page_opens_.end())
    return true;  // A mounted or already rejected offer is complete.
  const auto& target = found->second->target;
  if (target_tab_id)
    return target && target->tab_id == *target_tab_id;
  if (target)
    return false;  // An accepted page remains owned until mount or tab close.
  ReleasePageOpen(offer_id);
  return true;
}
void AppRuntime::ReleasePageOpen(std::string offer_id) {
  page_opens_.erase(offer_id);
  TabBroker::Get().ReleaseOffer(offer_id);
}
void AppRuntime::PageOpenMounted(const std::string& offer_id,
                                const std::string& tab_id) {
  const auto found = page_opens_.find(offer_id);
  if (found != page_opens_.end() && found->second->target &&
      found->second->target->tab_id == tab_id)
    page_opens_.erase(found);
}
Profile* AppRuntime::PageOpenProfileForWindow(const std::string& window_id) const {
  for (const auto& [id, opened] : page_opens_) {
    if (opened->target && opened->target->window_id == window_id &&
        opened->profile && opened->profile->IsOffTheRecord())
      return opened->profile.get();
  }
  return nullptr;
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
                       RuntimeResultKind result_kind,
                       mojom::AppRuntime::DispatchCallback callback) {
  auto pending = std::make_unique<Pending>();
  pending->connection = connection.weak_factory_.GetWeakPtr();
  pending->request_id = request_id;
  pending->result_kind = result_kind;
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
  auto projection = ProjectRuntimeState(
      *accepted_->FindDict("state"), id,
      WindowRegistry::Get().IsUtility(connection.window_.get()));
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
  page_events_started_ = false;
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
  page_events_started_ = false;
  while (!page_opens_.empty())
    ReleasePageOpen(page_opens_.begin()->first);
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
