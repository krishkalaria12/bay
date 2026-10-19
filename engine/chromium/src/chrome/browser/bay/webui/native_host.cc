// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/native_host.h"
#include "chrome/browser/bay/webui/native_contracts.g.h"

#include <cmath>
#include <optional>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/process/process_handle.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "bay/core/nn_devtools_call.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/bay/nn_dispatch.h"
#include "chrome/browser/bay/webui/app_runtime.h"
#include "chrome/browser/bay/webui/bay_webui.h"
#include "chrome/browser/bay/webui/browser_services.h"
#include "chrome/browser/bay/webui/engine_services.h"
#include "chrome/browser/bay/webui/page_observer.h"
#include "chrome/browser/bay/webui/page_services.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/bay/webui/window_registry.h"
#if BUILDFLAG(IS_WIN)
#include "chrome/browser/bay/data/data_services.h"
#include "chrome/browser/bay/webui/data_bridge.h"
#include "chrome/browser/bay/webui/notifications_win.h"
#include "chrome/browser/bay/webui/platform_services_win.h"
#include "chrome/browser/bay/webui/updater_service_win.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/lifetime/browser_close_manager.h"
#include "chrome/browser/lifetime/browser_shutdown.h"
#endif
#include "chrome/browser/browser_process.h"
#include "chrome/browser/devtools/devtools_window.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_tabstrip.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/webui_browser/webui_browser_window.h"
#include "chrome/common/chrome_paths.h"
#include "components/find_in_page/find_tab_helper.h"
#include "components/find_in_page/find_types.h"
#include "components/guest_contents/browser/guest_contents_handle.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/version_info/version_info.h"
#include "components/zoom/page_zoom.h"
#include "components/zoom/zoom_controller.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/common/page_zoom.h"

extern "C" void nn_engine_set_event_sink(nn_engine_event_t sink, void* context);

namespace bay {
namespace {
using Response = base::OnceCallback<void(const std::string&)>;
std::map<NativeHost*, base::WeakPtr<NativeHost>>& Hosts() {
  static base::NoDestructor<std::map<NativeHost*, base::WeakPtr<NativeHost>>>
      hosts;
  return *hosts;
}
#if BUILDFLAG(IS_WIN)
bool g_quit_requested = false;
bool g_quit_prepared = false;
UpdaterService& AppUpdater() {
  static base::NoDestructor<UpdaterService> updater(
      base::BindRepeating([](base::DictValue) {
        // Updater preferences and operation state are shared by every window.
        // A host-info update also refreshes the synchronous systemInfo
        // snapshot.
        for (const auto& [owner, host] : Hosts()) {
          if (host)
            host->PublishHostInfo();
        }
      }),
      base::BindRepeating(&chrome::AttemptExit));
  return *updater;
}
struct QuitPreparation {
  base::WeakPtr<NativeHost> owner;
  std::vector<base::OnceCallback<void(bool)>> callbacks;
  base::OneShotTimer deadline;
};
QuitPreparation& PendingQuit() {
  static base::NoDestructor<QuitPreparation> quit;
  return *quit;
}
void CompleteQuitPreparation(bool proceed) {
  auto& quit = PendingQuit();
  quit.deadline.Stop();
  quit.owner.reset();
  auto callbacks = std::exchange(quit.callbacks, {});
  for (auto& callback : callbacks)
    std::move(callback).Run(proceed);
}
base::WeakPtr<NativeHost> QuitOwner() {
  if (AppRuntime::Enabled()) {
    auto* runtime = AppRuntime::GetIfStarted();
    return runtime ? runtime->coordinator_host() : base::WeakPtr<NativeHost>();
  }
  return Hosts().size() == 1 ? Hosts().begin()->second
                             : base::WeakPtr<NativeHost>();
}
void PrepareRendererForQuit(base::OnceCallback<void(bool)> completion) {
  auto& quit = PendingQuit();
  if (!quit.callbacks.empty()) {
    quit.callbacks.push_back(std::move(completion));
    return;
  }
  if (base::CommandLine::ForCurrentProcess()->HasSwitch("bay-hosting-spike") ||
      Hosts().empty()) {
    std::move(completion).Run(true);
    return;
  }
  // Shared mode has one browser-owned coordinator, never an arbitrary visible
  // renderer selected by map order.
  auto owner = QuitOwner();
  if (!owner) {
    std::move(completion).Run(false);
    return;
  }
  quit.owner = owner;
  quit.callbacks.push_back(std::move(completion));
  quit.deadline.Start(FROM_HERE, base::Seconds(20),
                      base::BindOnce(&CompleteQuitPreparation, false));
  quit.owner->Emit("BayShell", "onAppEvent",
                   base::Value(base::DictValue().Set("type", "willQuit")));
}
void InstallCloseHooks() {
  static const bool installed = [] {
    WebUIBrowserWindow::SetBayCloseRequestHandler(
        [](BrowserWindowInterface* browser) {
          if (base::CommandLine::ForCurrentProcess()->HasSwitch(
                  "bay-hosting-spike") ||
              browser_shutdown::ShouldIgnoreUnloadHandlers() || g_quit_prepared)
            return false;
          const auto host = QuitOwner();
          if (!host)
            return false;
          if (AppRuntime::Enabled()) {
            auto* runtime = AppRuntime::GetIfStarted();
            if (runtime && runtime->IsRetiringStartupWindow(browser))
              return false;
            if (WindowRegistry::Get().Ids().size() > 1)
              return false;
            bool is_shell = false;
            for (const auto& [owner, candidate] : Hosts())
              is_shell |= candidate && candidate->browser() == browser;
            if (!is_shell)
              return false;
          } else if (host->browser() != browser) {
            return false;
          }
          // Posting lets WebUIBrowserWindow rearm the consumed widget callback
          // before application shutdown can synchronously call Close() again.
          if (!g_quit_requested && !browser_shutdown::IsTryingToQuit()) {
            g_quit_requested = true;
            base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
                FROM_HERE, base::BindOnce(&chrome::AttemptExit));
          }
          return true;
        });
    BrowserCloseManager::SetBayClosePreflight(
        [](base::OnceCallback<void(bool)> completion) {
          g_quit_requested = true;
          g_quit_prepared = false;
          if (browser_shutdown::ShouldIgnoreUnloadHandlers()) {
            std::move(completion).Run(TabBroker::Get().PrepareForQuit());
            return;
          }
          PrepareRendererForQuit(base::BindOnce(
              [](base::OnceCallback<void(bool)> completion, bool proceed) {
                if (!proceed) {
                  std::move(completion).Run(false);
                  return;
                }
                AppUpdater().PrepareForQuit(base::BindOnce(
                    [](base::OnceCallback<void(bool)> completion,
                       bool updater_ready) {
                      const bool prepared =
                          updater_ready && TabBroker::Get().PrepareForQuit();
                      g_quit_prepared = prepared;
                      std::move(completion).Run(prepared);
                    },
                    std::move(completion)));
              },
              std::move(completion)));
        },
        [] {
          g_quit_requested = false;
          g_quit_prepared = false;
          CompleteQuitPreparation(false);
          AppUpdater().CancelQuit();
          for (const auto& [owner, host] : Hosts()) {
            if (host)
              host->Emit(
                  "BayShell", "onAppEvent",
                  base::Value(base::DictValue().Set("type", "quitCancelled")));
          }
        });
    return true;
  }();
  (void)installed;
}
#endif
std::map<uintptr_t, base::WeakPtr<NativeHost>>& PendingOwners() {
  static base::NoDestructor<std::map<uintptr_t, base::WeakPtr<NativeHost>>>
      owners;
  return *owners;
}
uintptr_t g_next_reply = 0;
std::string JSON(const base::Value& value) {
  return base::WriteJson(value).value_or("null");
}
std::string JSON(const base::DictValue& value) {
  return base::WriteJson(value).value_or("{}");
}
std::string Success(base::Value value = base::Value()) {
  return JSON(base::DictValue().Set("value", std::move(value)));
}
std::string Failure(const char* code, const std::string& message) {
  return JSON(base::DictValue().Set(
      "error", base::DictValue().Set("code", code).Set("message", message)));
}
const base::Value* At(const base::ListValue& values, size_t index) {
  return index < values.size() ? &values[index] : nullptr;
}
std::string Text(const base::ListValue& values, size_t index) {
  const auto* value = At(values, index);
  return value && value->is_string() ? value->GetString() : "";
}
int Number(const base::ListValue& values, size_t index, int fallback = 0) {
  const auto* value = At(values, index);
  return value && value->is_int() ? value->GetInt() : fallback;
}
std::optional<std::string> EngineProfilePath(const std::string& id) {
  const bool valid =
      id.empty() || (id.size() <= 128 &&
                     id.find_first_not_of(
                         "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
                         "0123456789-_") == std::string::npos);
  if (!valid)
    return std::nullopt;
  base::FilePath root;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &root))
    return std::nullopt;
  return root.AppendASCII(id.empty() ? "Default" : id).AsUTF8Unsafe();
}
bool Boolean(const base::ListValue& values,
             size_t index,
             bool fallback = false) {
  const auto* value = At(values, index);
  return value && value->is_bool() ? value->GetBool() : fallback;
}
void EngineEvent(void*, const char* topic, const char* json) {
  // The NN engine guarantees UI-thread delivery. Hosts and Mojo remotes are
  // deliberately UI-thread confined; a background event source must post here.
  auto parsed =
      base::JSONReader::ReadDict(json ? json : "{}", base::JSON_PARSE_RFC);
  if (!parsed)
    return;
  if (const auto* path = parsed->FindString("profile")) {
    const auto name =
        base::FilePath::FromUTF8Unsafe(*path).BaseName().AsUTF8Unsafe();
    parsed->Set("profile", name == "Default" ? "" : name);
  }
  const std::string normalized_json = JSON(*parsed);
  std::vector<base::WeakPtr<NativeHost>> hosts;
  for (const auto& entry : Hosts())
    hosts.push_back(entry.second);
  for (const auto& host : hosts) {
    if (!host || (AppRuntime::Enabled() && !host->is_coordinator()))
      continue;
    host->Emit("BayCEF", "onEngineEvent",
               base::Value(base::DictValue()
                               .Set("topic", topic)
                               .Set("payload", normalized_json)));
    if (std::string_view(topic) == "downloads.changed") {
      if (const auto* download = parsed->FindDict("download")) {
        auto value = download->Clone();
        if (const auto* profile = parsed->FindString("profile"))
          value.Set("profile", *profile);
        host->Emit("BayCEF", "onDownload", base::Value(std::move(value)));
      }
    }
  }
}
int TabId(content::WebContents* contents) {
  return sessions::SessionTabHelper::IdForTab(contents).id();
}
#if BUILDFLAG(IS_WIN)
void DataEvent(const std::string& module,
               const std::string& event,
               const std::string& json) {
  auto payload = base::JSONReader::Read(json, base::JSON_PARSE_RFC);
  if (!payload)
    return;
  std::vector<base::WeakPtr<NativeHost>> hosts;
  for (const auto& entry : Hosts())
    hosts.push_back(entry.second);
  for (const auto& host : hosts)
    if (host && (!AppRuntime::Enabled() || host->is_coordinator()))
      host->Emit(module.c_str(), event.c_str(), payload->Clone());
}
#endif
}  // namespace

NativeHost::NativeHost(content::RenderFrameHost& frame,
                       HostContext context,
                       mojo::PendingReceiver<mojom::NativeHost> receiver)
    : DocumentService(frame, std::move(receiver)),
      context_(std::move(context)) {
  CHECK(context_.profile());
  CHECK_EQ(frame.GetBrowserContext(), context_.profile());
  Hosts()[this] = GetWeakPtr();
  if (Hosts().size() == 1)
    nn_engine_set_event_sink(&EngineEvent, nullptr);
  browser_services_ = std::make_unique<BrowserServices>(
      context_,
      base::BindRepeating(&NativeHost::InvokeBrowserEngine, GetWeakPtr()),
      base::BindRepeating(
          [](base::WeakPtr<NativeHost> host, const char* module,
             const char* event, base::DictValue payload) {
            if (host)
              host->Emit(module, event, base::Value(std::move(payload)));
          },
          GetWeakPtr()));
  engine_services_ = std::make_unique<EngineServices>(
      context_,
      base::BindRepeating(&NativeHost::InvokeBrowserEngine, GetWeakPtr()));
#if BUILDFLAG(IS_WIN)
  InstallCloseHooks();
  AppUpdater().Prepare(
      base::BindOnce(&NativeHost::PublishHostInfo, GetWeakPtr()));
  RegisterDataProfile(context_.profile());
  InitializeDataBridge(base::BindRepeating(&DataEvent));
  platform_services_ = std::make_unique<PlatformServices>(
      context_,
      base::BindRepeating(&NativeHost::PublishHostInfo, GetWeakPtr()));
  platform_services_->Prepare(
      base::BindOnce(&NativeHost::PlatformReady, GetWeakPtr()));
#endif
  if (context_.window()) {
    WindowRegistry::Get().RegisterHost(
        context_.window(), GetWeakPtr(),
        base::BindRepeating(&NativeHost::PublishHostInfo, GetWeakPtr()));
  }
}
NativeHost::~NativeHost() {
#if BUILDFLAG(IS_WIN)
  if (PendingQuit().owner.get() == this)
    CompleteQuitPreparation(false);
#endif
  WindowRegistry::Get().UnregisterHost(this);
  for (const auto& entry : pending_)
    PendingOwners().erase(entry.first);
  Hosts().erase(this);
#if BUILDFLAG(IS_WIN)
  bool notification_client = false;
  for (const auto& [owner, host] : Hosts()) {
    if (host && host->client_ &&
        (!AppRuntime::Enabled() || host->is_coordinator())) {
      notification_client = true;
      break;
    }
  }
  if (!notification_client)
    NotificationsWin::Get().SetEventSink({});
#endif
  if (Hosts().empty())
    nn_engine_set_event_sink(nullptr, nullptr);
}
base::DictValue NativeHost::Info() const {
  base::ListValue modules;
  for (const char* name : {"BayApp", "BayCEF", "BayShell", "BayWebView"})
    modules.Append(name);
  for (const auto& module : browser_services_->Modules())
    modules.Append(module.Clone());
#if BUILDFLAG(IS_WIN)
  for (const auto& module : data::ModuleNames())
    modules.Append(module);
  for (const auto& module : platform_services_->Modules()) {
    bool found = false;
    for (const auto& existing : modules)
      found |= existing == module;
    if (!found)
      modules.Append(module.Clone());
  }
#endif
  base::DictValue system;
  system.Set("platform",
#if BUILDFLAG(IS_WIN)
             "windows"
#else
             "linux"
#endif
  );
  system.Set("version", version_info::GetVersionNumber());
  system.Set("appName", "Bay");
  system.Set("appVersion", version_info::GetVersionNumber());
  system.Set("appBuild", version_info::GetLastChange());
  system.Set("bundleId", "Bay.Browser");
#if defined(NDEBUG)
  system.Set("configuration", "Release");
#else
  system.Set("configuration", "Debug");
#endif
  system.Set("osVersion", base::SysInfo::OperatingSystemVersion());
  system.Set("osBuild", base::SysInfo::OperatingSystemVersion());
  system.Set("arch", base::SysInfo::OperatingSystemArchitecture());
  system.Set("model", "Desktop");
  system.Set("memoryGB", base::SysInfo::AmountOfTotalPhysicalMemory().InGiBF());
  system.Set("locale", g_browser_process->GetApplicationLocale());
  system.Set("updates", false);
  base::DictValue shell;
  shell.Set("role", context_.role_name());
  shell.Set("sharedRuntime", AppRuntime::Enabled());
  if (auto* window = context_.window()) {
    const std::string window_id = WindowRegistry::Get().IdFor(window);
    if (!window_id.empty())
      shell.Set("windowId", window_id);
    shell.Set("windowOptions", WindowRegistry::Get().OptionsFor(window));
  }
  shell.Set("hostingSpike", base::CommandLine::ForCurrentProcess()->HasSwitch(
                                "bay-hosting-spike"));
#if BUILDFLAG(IS_WIN)
  shell.Set("initializationError", platform_services_->initialization_error());
#endif
  auto engine_methods = browser_services_->SupportedMethods();
  for (const auto& method : engine_services_->SupportedMethods())
    engine_methods.Append(method.Clone());
  auto info =
      base::DictValue()
          .Set("contractVersion", 2)
          .Set("role", context_.role_name())
          .Set("platform", system.FindString("platform")
                               ? *system.FindString("platform")
                               : "linux")
          .Set("modules", std::move(modules))
          .Set("views", context_.is_window()
                            ? base::ListValue().Append("BayWebView")
                            : base::ListValue())
          .Set("optionalMethods", std::move(engine_methods))
          .Set("constants",
               base::DictValue()
                   .Set("BayApp", base::DictValue().Set("apiVersion", 9))
                   .Set("BayShell", std::move(shell)))
          .Set("snapshots",
               base::DictValue()
                   .Set("BayApp", base::DictValue()
                                      .Set("systemInfo", std::move(system))
                                      .Set("environment", base::DictValue()))
                   .Set("BayShell",
                        base::DictValue().Set("documents", base::DictValue()))
                   .Set("BaySystem",
                        base::DictValue()
                            .Set("files", base::DictValue())
                            .Set("downloadsFolder", base::Value())));
#if BUILDFLAG(IS_WIN)
  auto snapshots = platform_services_->Snapshots();
  if (auto* app = snapshots.FindDict("BayApp")) {
    if (auto* system_info = app->FindDict("systemInfo"))
      system_info->Set(
          "updates",
          AppUpdater().State().FindBool("available").value_or(false));
    app->Set("updaterState", AppUpdater().State());
  }
  if (auto result = base::JSONReader::ReadDict(
          data::Invoke("BaySync", "deviceName", "[]"), base::JSON_PARSE_RFC)) {
    if (const auto* name = result->Find("value"); name && name->is_string())
      snapshots.Set("BaySync",
                    base::DictValue().Set("deviceName", name->Clone()));
  }
  info.Set("snapshots", std::move(snapshots));
  auto methods = platform_services_->SupportedMethods();
  for (const auto& method : browser_services_->SupportedMethods())
    methods.Append(method.Clone());
  for (const auto& method : engine_services_->SupportedMethods())
    methods.Append(method.Clone());
  methods.Append("BayShell.windowFrame");
  methods.Append("BayShell.replyToTerminate");
  for (const auto* method :
       {"BayApp.checkForUpdates", "BayApp.setAutomaticUpdateChecks",
        "BayApp.setAutomaticUpdateDownloads"})
    methods.Append(method);
  for (const auto& module : data::ModuleNames())
    for (const auto& method : data::MethodNames(module))
      methods.Append(module + "." + method);
  info.Set("optionalMethods", std::move(methods));
#endif
  return info;
}
void NativeHost::GetHostInfo(GetHostInfoCallback callback) {
#if BUILDFLAG(IS_WIN)
  if (!platform_ready_) {
    host_info_callbacks_.push_back(std::move(callback));
    return;
  }
#endif
  std::move(callback).Run(JSON(Info()));
}
void NativeHost::PublishHostInfo() {
#if BUILDFLAG(IS_WIN)
  if (!platform_ready_)
    return;
#endif
  if (client_)
    client_->OnHostInfoChanged(JSON(Info()));
}
#if BUILDFLAG(IS_WIN)
void NativeHost::PlatformReady() {
  platform_ready_ = true;
  const std::string json = JSON(Info());
  auto callbacks = std::move(host_info_callbacks_);
  for (auto& callback : callbacks)
    std::move(callback).Run(json);
  PublishHostInfo();
}
#endif
void NativeHost::SetClient(
    mojo::PendingRemote<mojom::NativeHostClient> client) {
  client_.reset();
  client_.Bind(std::move(client));
#if BUILDFLAG(IS_WIN)
  if (!AppRuntime::Enabled() || is_coordinator()) {
    // Activation can arrive before the trusted document connects. Drain only
    // after its Mojo client is bound; the renderer retains startup responses
    // until app integration subscribes.
    NotificationsWin::Get().SetEventSink(base::BindRepeating(
        [](base::DictValue response) {
          DataEvent("BayApp", "onNotificationResponse", JSON(response));
        }));
  }
#endif
}
void NativeHost::Emit(const char* module,
                      const char* event,
                      base::Value payload) {
  if (client_)
    client_->OnNativeEvent(module, event, JSON(payload));
}
void NativeHost::ViewEvent(int tag,
                           const char* event,
                           base::DictValue payload) {
  Emit("BayCEF", "onViewEvent",
       base::Value(base::DictValue()
                       .Set("tag", tag)
                       .Set("event", event)
                       .Set("payload", std::move(payload))));
}
content::WebContents* NativeHost::ContentsForTag(int tag) const {
  const auto found = tabs_.find(tag);
  return found != tabs_.end() && found->second->current()
             ? found->second->contents()
             : nullptr;
}
void NativeHost::InvokeEngine(const std::string& name,
                              const std::string& profile,
                              base::DictValue args,
                              bool raw_json,
                              InvokeCallback callback) {
  if (!context_.profile()) {
    std::move(callback).Run(Failure("profile_unavailable",
                                    "The host profile is no longer available"));
    return;
  }
  const uintptr_t token = ++g_next_reply;
  pending_.emplace(token, std::make_pair(raw_json, std::move(callback)));
  PendingOwners()[token] = GetWeakPtr();
  const std::string json = JSON(args);
  if (!DispatchEngineCall(
          name, profile.c_str(), json.c_str(),
          [](void* context, const char* json) {
            auto found =
                PendingOwners().find(reinterpret_cast<uintptr_t>(context));
            if (found == PendingOwners().end())
              return;
            auto owner = found->second;
            PendingOwners().erase(found);
            if (owner)
              owner->CompleteEngine(reinterpret_cast<uintptr_t>(context), json);
          },
          reinterpret_cast<void*>(token))) {
    CompleteEngine(token, "{\"error\":\"engine call unavailable\"}");
    PendingOwners().erase(token);
  }
}
void NativeHost::InvokeBrowserEngine(const std::string& name,
                                     const std::string& profile_id,
                                     base::DictValue args,
                                     InvokeCallback callback) {
  const auto profile = EngineProfilePath(profile_id);
  if (!profile) {
    std::move(callback).Run(
        Failure("invalid_profile", "Invalid Bay profile identifier"));
    return;
  }
  InvokeEngine(name, *profile, std::move(args), false, std::move(callback));
}
void NativeHost::CompleteEngine(uintptr_t token, const char* json) {
  auto found = pending_.find(token);
  if (found == pending_.end())
    return;
  auto [raw_json, callback] = std::move(found->second);
  pending_.erase(found);
  auto result =
      base::JSONReader::Read(json ? json : "{}", base::JSON_PARSE_RFC);
  if (!result) {
    std::move(callback).Run(
        Failure("invalid_result", "engine returned invalid JSON"));
    return;
  }
  if (!raw_json && result->is_dict()) {
    if (const auto* error = result->GetDict().FindString("error")) {
      std::move(callback).Run(Failure("engine_error", *error));
      return;
    }
  }
  std::move(callback).Run(
      Success(raw_json ? base::Value(json) : std::move(*result)));
}
void NativeHost::Invoke(const std::string& module,
                        const std::string& method,
                        const std::string& args_json,
                        InvokeCallback callback) {
  if (!context_.profile()) {
    std::move(callback).Run(Failure("profile_unavailable",
                                    "The host profile is no longer available"));
    return;
  }
  auto parsed = base::JSONReader::Read(args_json, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_list()) {
    std::move(callback).Run(
        Failure("invalid_args", "native arguments must be an array"));
    return;
  }
  const auto& args = parsed->GetList();
  const auto* contract = contracts::FindMethod(module, method);
  if (!contract) {
    std::move(callback).Run(Failure("unknown_method", "Unknown native method"));
    return;
  }
  if (args.size() < contract->min_args ||
      (contract->max_args >= 0 &&
       args.size() > static_cast<size_t>(contract->max_args))) {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid native argument count"));
    return;
  }
  if (module == "BayWebView") {
    InvokeView(method, args, std::move(callback));
    return;
  }
  if (browser_services_->DispatchBrowserModule(module, method, args, callback))
    return;
  if (engine_services_->DispatchEngineModule(module, method, args, callback))
    return;
#if BUILDFLAG(IS_WIN)
  if (module == "BayShell" && method == "replyToTerminate") {
    if (!args[0].is_bool()) {
      std::move(callback).Run(
          Failure("invalid_args", "Quit reply must be a boolean"));
      return;
    }
    if (PendingQuit().owner.get() != this) {
      std::move(callback).Run(
          Failure("stale_quit", "This document has no pending quit request"));
      return;
    }
    std::move(callback).Run(Success());
    CompleteQuitPreparation(args[0].GetBool());
    return;
  }
  if (module == "BayApp") {
    if (method == "checkForUpdates" && !context_.window()) {
      std::move(callback).Run(Failure(
          "window_required", "A manual update check requires a window"));
      return;
    }
    if (AppUpdater().Dispatch(context_.window(), method, args, callback))
      return;
    if (method == "systemInfo") {
      auto info = Info();
      const auto* system = info.FindByDottedPath("snapshots.BayApp.systemInfo");
      std::move(callback).Run(
          Success(system ? system->Clone() : base::Value()));
      return;
    }
  }
  if (module == "BayImport" || module == "BaySync") {
    if (data::RequiresUIThread(module, method)) {
      std::move(callback).Run(data::Invoke(module, method, args_json));
    } else {
      base::ThreadPool::PostTaskAndReplyWithResult(
          FROM_HERE,
          {base::MayBlock(), base::WithBaseSyncPrimitives(),
           base::TaskPriority::USER_VISIBLE},
          base::BindOnce(&data::Invoke, module, method, args_json),
          std::move(callback));
    }
    return;
  }
  if (platform_services_->DispatchPlatformModule(module, method, args,
                                                 callback))
    return;
#endif
  if (module == "BayCEF" && method == "engineCall") {
    if (!IsWebEngineCall(Text(args, 0))) {
      std::move(callback).Run(
          Failure("unsupported_engine_call",
                  "This engine operation is not exposed to JavaScript"));
      return;
    }
    auto arguments = base::JSONReader::ReadDict(
        Text(args, 2).empty() ? "{}" : Text(args, 2), base::JSON_PARSE_RFC);
    if (!arguments) {
      std::move(callback).Run(
          Failure("invalid_args", "engine arguments must be an object"));
      return;
    }
    const auto profile = EngineProfilePath(Text(args, 1));
    if (!profile) {
      std::move(callback).Run(Failure(
          "invalid_profile", "The profile must be a Bay profile identifier"));
      return;
    }
    InvokeEngine(Text(args, 0), *profile, std::move(*arguments), true,
                 std::move(callback));
    return;
  }
  if (module == "BayCEF" && method == "engineInfo") {
    int windows = 0;
    int popups = 0;
    GlobalBrowserCollection::GetInstance()->ForEach(
        [&](BrowserWindowInterface* browser) {
          ++windows;
          if (browser->GetType() == BrowserWindowInterface::Type::TYPE_POPUP)
            ++popups;
          return true;
        });
    std::move(callback).Run(Success(base::Value(
        base::DictValue()
            .Set("pid", static_cast<int>(base::GetCurrentProcId()))
            .Set("dataDirectory",
                 [] {
                   base::FilePath directory;
                   return base::PathService::Get(chrome::DIR_USER_DATA,
                                                 &directory)
                              ? directory.AsUTF8Unsafe()
                              : std::string();
                 }())
            .Set("engine", "NNCore")
            .Set("chromiumVersion", version_info::GetVersionNumber())
            .Set("liveBrowsers", static_cast<int>(tabs_.size()))
            .Set("popupWindows", popups)
            .Set("chromeWindows", windows))));
    return;
  }
  if (module == "BayCEF" && method == "prepareTransfer") {
    const auto error = TabBroker::Get().PrepareTransfer(Text(args, 0));
    std::move(callback).Run(error ? Failure("transfer_failed", *error)
                                  : Success());
    return;
  }
  if (module == "BayCEF" && method == "releaseTransfer") {
    TabBroker::Get().ReleaseTransfer(Text(args, 0));
    std::move(callback).Run(Success());
    return;
  }
  if (module == "BayShell") {
    auto& windows = WindowRegistry::Get();
    if (method == "windowIds") {
      std::move(callback).Run(Success(base::Value(windows.Ids())));
      return;
    }
    if (method == "windowFrame") {
      const auto frame = windows.Frame(Text(args, 0));
      std::move(callback).Run(
          Success(frame ? base::Value(base::ListValue()
                                          .Append(frame->x())
                                          .Append(frame->y())
                                          .Append(frame->width())
                                          .Append(frame->height()))
                        : base::Value()));
      return;
    }
    std::optional<WindowRegistry::Result> result;
    if (method == "openWindow") {
      if (context_.is_window() && !context_.window()) {
        std::move(callback).Run(Failure(
            "window_required", "The requesting window is no longer available"));
        return;
      }
      const auto* options = At(args, 1);
      if (!options || !options->is_dict()) {
        std::move(callback).Run(
            Failure("invalid_args", "Window options required"));
        return;
      }
      const auto id = Text(args, 0);
      // Each full UI currently owns one Zustand runtime. A second independent
      // runtime could overwrite session state. The diagnostic has no app store
      // and can exercise native window behavior while the coordinator is built.
      if (!windows.Find(id) && !windows.Ids().empty() &&
          !base::CommandLine::ForCurrentProcess()->HasSwitch(
              "bay-hosting-spike")) {
        std::move(callback).Run(Failure(
            "unavailable",
            "Additional windows require the shared application runtime"));
        return;
      }
      result = windows.Open(context_, id, options->GetDict());
    } else if (method == "closeWindow")
      result = windows.Close(Text(args, 0));
    else if (method == "focusWindow")
      result = windows.Focus(Text(args, 0));
    else if (method == "setWindowTitle")
      result = windows.SetTitle(Text(args, 0), Text(args, 1));
    else if (method == "minimizeWindow")
      result = windows.Minimize(Text(args, 0));
    if (result) {
      std::move(callback).Run(
          result->ok ? Success() : Failure("window_error", result->error));
      return;
    }
  }
  std::move(callback).Run(Failure(
      "unsupported_method", module + "." + method + " is not implemented"));
}
void NativeHost::InvokeView(const std::string& method,
                            const base::ListValue& args,
                            InvokeCallback callback) {
  if (!context_.window()) {
    std::move(callback).Run(
        Failure("window_required", "Native views require a window host"));
    return;
  }
  const int tag = Number(args, 0, -1);
  if (tag < 0) {
    std::move(callback).Run(Failure("invalid_args", "view tag required"));
    return;
  }
  if (method == "unmount") {
    const auto found = tabs_.find(tag);
    if (found != tabs_.end()) {
      auto* contents = found->second->contents();
      const auto lease = found->second->lease();
      tabs_.erase(found);
      if (contents)
        TabBroker::Get().Unmount(contents, lease);
    }
    std::move(callback).Run(Success());
    return;
  }
  if (method == "mount") {
    const auto* raw = At(args, 2);
    if (!raw || !raw->is_dict() || tabs_.count(tag)) {
      std::move(callback).Run(
          Failure("invalid_args", "unique view tag and props required"));
      return;
    }
    const auto& props = raw->GetDict();
    auto mounted = TabBroker::Get().Mount(context_.window(), props);
    if (!mounted.contents) {
      std::move(callback).Run(Failure("mount_failed", mounted.error));
      return;
    }
    auto* contents = mounted.contents;
    engine_services_->TrackTab(contents);
    if (auto muted = props.FindBool("muted"))
      contents->SetAudioMuted(*muted);
    if (auto frozen = props.FindBool("frozen"))
      contents->SetPageFrozen(*frozen);
    auto* handle =
        guest_contents::GuestContentsHandle::CreateForWebContents(contents);
    const auto* url = props.FindString("url");
    tabs_[tag] = std::make_unique<TabObserver>(
        contents, tag, mounted.lease,
        url ? std::make_optional(*url) : std::nullopt, GetWeakPtr());
    std::move(callback).Run(
        Success(base::Value(base::DictValue()
                                .Set("surfaceId", handle->id().ToString())
                                .Set("browserId", TabId(contents))
                                .Set("chromeTabId", TabId(contents)))));
    tabs_[tag]->State();
    return;
  }
  auto* contents = ContentsForTag(tag);
  if (!contents) {
    std::move(callback).Run(Failure("no_tab", "view has no live tab"));
    return;
  }
  if (method == "update") {
    const auto* raw = At(args, 1);
    if (!raw || !raw->is_dict()) {
      std::move(callback).Run(Failure("invalid_args", "view props required"));
      return;
    }
    const auto& props = raw->GetDict();
    const auto* url = props.FindString("url");
    const auto requested_url = url ? std::make_optional(*url) : std::nullopt;
    auto& observer = *tabs_.at(tag);
    if (url && requested_url != observer.requested_url()) {
      const GURL target(*url);
      if (!target.is_valid() || target.SchemeIs("javascript") ||
          target.SchemeIs("bay")) {
        std::move(callback).Run(
            Failure("invalid_url", "Navigation URL is not allowed"));
        return;
      }
      contents->GetController().LoadURL(target, content::Referrer(),
                                        ui::PAGE_TRANSITION_TYPED, "");
    }
    observer.set_requested_url(requested_url);
    if (auto mute = props.FindBool("muted"))
      contents->SetAudioMuted(*mute);
    if (auto frozen = props.FindBool("frozen"))
      contents->SetPageFrozen(*frozen);
    if (props.FindBool("visible").value_or(false)) {
      auto* model = context_.window()->GetTabStripModel();
      model->ActivateTabAt(model->GetIndexOfWebContents(contents));
    }
    std::move(callback).Run(Success());
    return;
  }
  if (method != "call") {
    std::move(callback).Run(Failure("unsupported_method", method));
    return;
  }
  const auto command = Text(args, 1);
  const auto* raw = At(args, 2);
  const auto* values = raw && raw->is_list() ? &raw->GetList() : nullptr;
  const base::ListValue empty;
  const auto& params = values ? *values : empty;
  if (command == "loadUrl" || command == "loadURL" || command == "navigate") {
    const GURL url(Text(params, 0));
    if (!url.is_valid() || url.SchemeIs("javascript") || url.SchemeIs("bay")) {
      std::move(callback).Run(
          Failure("invalid_url", "navigation URL is not allowed"));
      return;
    }
    contents->GetController().LoadURL(url, content::Referrer(),
                                      ui::PAGE_TRANSITION_TYPED, "");
  } else if (command == "goBack" || command == "back") {
    if (contents->GetController().CanGoBack())
      contents->GetController().GoBack();
  } else if (command == "goForward" || command == "forward") {
    if (contents->GetController().CanGoForward())
      contents->GetController().GoForward();
  } else if (command == "goToOffset") {
    auto& controller = contents->GetController();
    const int offset = Number(params, 0);
    if (controller.CanGoToOffset(offset))
      controller.GoToOffset(offset);
  } else if (command == "navigationEntries") {
    auto& controller = contents->GetController();
    base::ListValue entries;
    for (int i = 0; i < controller.GetEntryCount(); ++i) {
      const auto* entry = controller.GetEntryAtIndex(i);
      entries.Append(
          base::DictValue()
              .Set("url", entry->GetURL().spec())
              .Set("title", base::UTF16ToUTF8(entry->GetTitle()))
              .Set("current", i == controller.GetCurrentEntryIndex()));
    }
    std::move(callback).Run(Success(base::Value(std::move(entries))));
    return;
  } else if (command == "reload" || command == "reloadIgnoringCache" ||
             command == "forceReload")
    contents->GetController().Reload(command == "reload"
                                         ? content::ReloadType::NORMAL
                                         : content::ReloadType::BYPASSING_CACHE,
                                     true);
  else if (command == "stop" || command == "stopLoading")
    contents->Stop();
  else if (command == "focus") {
    auto* model = context_.window()->GetTabStripModel();
    model->ActivateTabAt(model->GetIndexOfWebContents(contents));
    contents->Focus();
  } else if (command == "showDevTools")
    DevToolsWindow::OpenDevToolsWindow(contents, DevToolsToggleAction::Show(),
                                       DevToolsOpenedByAction::kUnknown);
  else if (command == "zoomStep") {
    const int direction = Number(params, 0);
    zoom::PageZoom::Zoom(contents, direction > 0   ? content::PAGE_ZOOM_IN
                                   : direction < 0 ? content::PAGE_ZOOM_OUT
                                                   : content::PAGE_ZOOM_RESET);
  } else if (command == "setFrozen")
    contents->SetPageFrozen(Boolean(params, 0));
  else if (command == "setMuted" || command == "setAudioMuted" ||
           command == "mute")
    contents->SetAudioMuted(Boolean(params, 0));
  else if (command == "close" || command == "closeNow")
    contents->ClosePage();
  else if (command == "executeJavaScript" || command == "execute" ||
           command == "evaluateJavaScript" || command == "evaluate" ||
           command == "evaluateWithGesture") {
    base::DictValue request;
    request.Set("expression", Text(params, 0));
    request.Set("returnByValue", true);
    request.Set("awaitPromise", true);
    request.Set("userGesture", command == "evaluateWithGesture");
    nncore::CallDevTools(
        contents, "Runtime.evaluate", std::move(request), base::Seconds(10),
        base::BindOnce(
            [](InvokeCallback callback, std::optional<base::DictValue> result,
               std::optional<std::string> error) {
              if (error || !result) {
                std::move(callback).Run(
                    Failure("evaluation_failed", error.value_or("no result")));
                return;
              }
              if (result->contains("exceptionDetails")) {
                std::move(callback).Run(
                    Failure("javascript_error", "evaluation threw"));
                return;
              }
              const auto* remote = result->FindDict("result");
              const auto* value = remote ? remote->Find("value") : nullptr;
              std::move(callback).Run(
                  Success(base::Value(value ? JSON(*value) : "null")));
            },
            std::move(callback)));
    return;
  } else if (command == "find") {
    if (auto* find = find_in_page::FindTabHelper::FromWebContents(contents))
      find->StartFinding(base::UTF8ToUTF16(Text(params, 0)),
                         Boolean(params, 1, true), false, true);
  } else if (command == "stopFinding") {
    if (auto* find = find_in_page::FindTabHelper::FromWebContents(contents))
      find->StopFinding(Boolean(params, 0)
                            ? find_in_page::SelectionAction::kClear
                            : find_in_page::SelectionAction::kKeep);
  } else if (DispatchPageMethod(contents, command, params, callback)) {
    return;
  } else {
    std::move(callback).Run(
        Failure("unsupported_method", "WebView." + command));
    return;
  }
  std::move(callback).Run(Success());
}

void BindNativeHost(content::WebUI* web_ui,
                    mojo::PendingReceiver<mojom::NativeHost> receiver) {
  auto* contents = web_ui->GetWebContents();
  auto* frame = contents->GetPrimaryMainFrame();
  auto* window = WebUIBrowserWindow::FromWebShellWebContents(contents);
  // A normal tab can navigate to chrome://bay, but it cannot acquire host
  // privileges: only the window's own WebShell has this association.
  if (!frame || frame->GetLastCommittedURL() != GURL(kBayURL))
    return;
  auto* runtime = AppRuntime::GetIfStarted();
  if (runtime && runtime->Owns(contents) && runtime->profile()) {
    auto* host =
        new NativeHost(*frame, HostContext::ForCoordinator(*runtime->profile()),
                       std::move(receiver));
    runtime->SetCoordinatorHost(host->GetWeakPtr());
    return;
  }
  if (!window)
    return;
  AppRuntime::StartForWindow(*window->browser());
  new NativeHost(*frame, HostContext::ForWindow(*window->browser()),
                 std::move(receiver));
}
void EmitWindowCommand(BrowserWindowInterface* browser, const char* command) {
  for (const auto& entry : Hosts())
    if (entry.second && entry.second->browser() == browser)
      entry.second->Emit(
          "BayShell", "onCommand",
          base::Value(base::DictValue().Set("command", command)));
}
}  // namespace bay
