// Copyright 2026 Bay. Apache-2.0.
// Windows host over the patched CEF Chrome runtime. All browser objects live on
// CEF's UI thread; the host ABI contains no CEF or Chromium types.
#define NNCORE_IMPLEMENTATION
#include "bay/core/public/nn_engine_calls.h"
#include "bay/core/public/nncore_c.h"

#include <windows.h>

#include <atomic>
#include <charconv>
#include <cmath>
#include <filesystem>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "cef/include/cef_app.h"
#include "cef/include/cef_browser.h"
#include "cef/include/cef_client.h"
#include "cef/include/cef_command_line.h"
#include "cef/include/cef_devtools_message_observer.h"
#include "cef/include/cef_parser.h"
#include "cef/include/cef_request_context_handler.h"
#include "cef/include/cef_task.h"
#include "cef/include/cef_version.h"

namespace {
using Dict = CefRefPtr<CefDictionaryValue>;
using Value = CefRefPtr<CefValue>;

enum class Phase { kNew, kStarting, kReady, kClosing, kStopped };
std::atomic<Phase> g_phase{Phase::kNew};
std::atomic<int> g_browser_count{0};
DWORD g_initialization_thread = 0;
bool g_external_pump = true;
std::filesystem::path g_root_cache;
std::mutex g_sink_mutex;
nncore_event_t g_sink = nullptr;
void *g_sink_context = nullptr;

Dict Object() { return CefDictionaryValue::Create(); }
std::string String(Dict d, const char *key) {
  return d->GetString(key).ToString();
}
int Int(Dict d, const char *key, int fallback = 0) {
  if (d->GetType(key) == VTYPE_INT)
    return d->GetInt(key);
  if (d->GetType(key) != VTYPE_DOUBLE)
    return fallback;
  const double value = d->GetDouble(key);
  return std::isfinite(value) && value >= std::numeric_limits<int>::min() &&
                 value <= std::numeric_limits<int>::max()
             ? static_cast<int>(std::round(value))
             : fallback;
}
bool Bool(Dict d, const char *key, bool fallback = false) {
  return d->GetType(key) == VTYPE_BOOL ? d->GetBool(key) : fallback;
}
std::string JSON(Dict d) {
  auto v = CefValue::Create();
  v->SetDictionary(d);
  return CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
}
Dict Parse(const char *json) {
  auto v = CefParseJSON(json ? json : "{}", JSON_PARSER_RFC);
  return v && v->GetType() == VTYPE_DICTIONARY ? v->GetDictionary() : nullptr;
}
Dict WithId(int id) {
  auto d = Object();
  d->SetInt("id", id);
  return d;
}
void Emit(const char *topic, Dict payload) {
  nncore_event_t sink;
  void *context;
  {
    std::lock_guard<std::mutex> lock(g_sink_mutex);
    sink = g_sink;
    context = g_sink_context;
  }
  if (sink) {
    const auto json = JSON(payload);
    sink(context, topic, json.c_str());
  }
}

class Reply {
public:
  Reply(nncore_reply_t callback, void *context)
      : callback_(callback), context_(context) {}
  void Send(Dict d) {
    if (callback_) {
      auto cb = std::exchange(callback_, nullptr);
      const auto json = JSON(d);
      cb(context_, json.c_str());
    }
  }
  void Error(const char *error) {
    auto d = Object();
    d->SetString("error", error);
    Send(d);
  }
  void Ok() {
    auto d = Object();
    d->SetBool("ok", true);
    Send(d);
  }
  void Forward(const char *json) {
    if (callback_) {
      auto cb = std::exchange(callback_, nullptr);
      cb(context_, json);
    }
  }

private:
  nncore_reply_t callback_;
  void *context_;
};

class Task final : public CefTask {
public:
  explicit Task(std::function<void()> work) : work_(std::move(work)) {}
  void Execute() override { work_(); }

private:
  std::function<void()> work_;
  IMPLEMENT_REFCOUNTING(Task);
};
void OnUI(std::function<void()> work, std::shared_ptr<Reply> reply) {
  if (CefCurrentlyOn(TID_UI)) {
    work();
    return;
  }
  if (!CefPostTask(TID_UI, new Task(std::move(work))))
    reply->Error("engine UI thread unavailable");
}

class Client;
std::map<int, CefRefPtr<CefBrowser>> g_browsers;
std::map<int, CefRefPtr<Client>> g_clients;
std::map<uintptr_t, std::shared_ptr<Reply>> g_engine_calls;
uintptr_t g_next_call = 0;
std::map<std::string, CefRefPtr<CefRequestContext>> g_profiles;
std::map<uint64_t, CefRefPtr<CefPermissionPromptCallback>> g_permissions;
int g_popup_id = 1000000000;

void ReadyToShutdown() {
  if (g_phase != Phase::kClosing || !g_browsers.empty())
    return;
  // Complete outstanding service calls before profiles are destroyed. Late
  // Chrome callbacks contain numeric tokens, so they cannot dereference freed
  // host callback storage.
  auto pending = std::move(g_engine_calls);
  g_engine_calls.clear();
  for (const auto &entry : pending)
    entry.second->Error("engine is closing");
  g_permissions.clear();
  g_profiles.clear();
  Emit("engine.readyToShutdown", Object());
}
void EngineEvent(void *, const char *topic, const char *json) {
  auto payload = Object();
  payload->SetString("topic", topic ? topic : "");
  payload->SetString("payload", json ? json : "{}");
  Emit("engine.event", payload);
}
using EngineSink = void (*)(void (*)(void *, const char *, const char *),
                            void *);
void SetEngineSink(bool enabled) {
  if (auto lib = GetModuleHandleW(L"libcef.dll")) {
    auto sink = reinterpret_cast<EngineSink>(
        GetProcAddress(lib, "nn_engine_set_event_sink"));
    if (sink)
      sink(enabled ? EngineEvent : nullptr, nullptr);
  }
}

class Client final : public CefClient,
                     public CefLifeSpanHandler,
                     public CefDisplayHandler,
                     public CefLoadHandler,
                     public CefFindHandler,
                     public CefPermissionHandler,
                     public CefDevToolsMessageObserver {
public:
  explicit Client(int id) : id_(id) {}
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefFindHandler> GetFindHandler() override { return this; }
  CefRefPtr<CefPermissionHandler> GetPermissionHandler() override {
    return this;
  }
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    g_browsers.emplace(id_, browser);
    g_clients[id_] = this;
    devtools_registration_ =
        browser->GetHost()->AddDevToolsMessageObserver(this);
    ++g_browser_count;
    auto d = WithId(id_);
    d->SetInt("browserId", browser->GetIdentifier());
    d->SetInt("chromeTabId", browser->GetHost()->GetTabId());
    Emit("tab.created", d);
  }
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    FailDevTools("tab closed");
    devtools_registration_ = nullptr;
    g_clients.erase(id_);
    g_browsers.erase(id_);
    --g_browser_count;
    Emit("tab.closed", WithId(id_));
    ReadyToShutdown();
  }
  bool OnBeforePopup(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                     int popup_id, const CefString &target_url,
                     const CefString &target_frame_name,
                     WindowOpenDisposition disposition, bool user_gesture,
                     const CefPopupFeatures &features, CefWindowInfo &info,
                     CefRefPtr<CefClient> &client, CefBrowserSettings &settings,
                     CefRefPtr<CefDictionaryValue> &extra_info,
                     bool *no_javascript_access) override {
    if (g_phase != Phase::kReady)
      return true;
    // Keep JavaScript opener and Chrome's popup permission decisions. The host
    // hears about the real popup and can reparent it via tab.parent.
    const int id = ++g_popup_id;
    client = new Client(id);
    settings.client_window = STATE_DISABLED;
    auto d = WithId(id_);
    d->SetInt("popupId", id);
    d->SetString("url", target_url);
    d->SetInt("disposition", disposition);
    d->SetBool("userGesture", user_gesture);
    Emit("tab.popup", d);
    return false;
  }
  void OnAddressChange(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame,
                       const CefString &url) override {
    if (!frame->IsMain())
      return;
    auto d = WithId(id_);
    d->SetString("url", url);
    Emit("tab.changed", d);
  }
  void OnTitleChange(CefRefPtr<CefBrowser>, const CefString &title) override {
    auto d = WithId(id_);
    d->SetString("title", title);
    Emit("tab.changed", d);
  }
  void OnFaviconURLChange(CefRefPtr<CefBrowser>,
                          const std::vector<CefString> &urls) override {
    auto d = WithId(id_);
    d->SetString("favicon", urls.empty() ? CefString() : urls.front());
    Emit("tab.changed", d);
  }
  void OnLoadingStateChange(CefRefPtr<CefBrowser>, bool loading, bool back,
                            bool forward) override {
    auto d = WithId(id_);
    d->SetBool("loading", loading);
    d->SetBool("canGoBack", back);
    d->SetBool("canGoForward", forward);
    Emit("tab.changed", d);
  }
  void OnLoadError(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame,
                   ErrorCode code, const CefString &text,
                   const CefString &url) override {
    if (!frame->IsMain() || code == ERR_ABORTED)
      return;
    auto d = WithId(id_);
    d->SetInt("errorCode", code);
    d->SetString("error", text);
    d->SetString("url", url);
    Emit("tab.changed", d);
  }
  void OnFindResult(CefRefPtr<CefBrowser>, int identifier, int count,
                    const CefRect &selection, int active, bool final) override {
    auto d = WithId(id_);
    d->SetInt("count", count);
    d->SetInt("active", active);
    d->SetBool("final", final);
    Emit("tab.findResult", d);
  }
  bool OnShowPermissionPrompt(
      CefRefPtr<CefBrowser>, uint64_t prompt_id, const CefString &origin,
      uint32_t permissions,
      CefRefPtr<CefPermissionPromptCallback> callback) override {
    // Returning false keeps permission decisions in Chrome's native UI. Do not
    // consume a prompt until the host implements all permission kinds.
    return false;
  }
  void
  OnDismissPermissionPrompt(CefRefPtr<CefBrowser>, uint64_t prompt_id,
                            cef_permission_request_result_t result) override {
    g_permissions.erase(prompt_id);
    auto d = Object();
    d->SetString("id", std::to_string(prompt_id));
    Emit("permission.dismissed", d);
  }
  void DevTools(CefRefPtr<CefBrowser> browser, const std::string &method,
                Dict params, std::shared_ptr<Reply> reply,
                bool evaluate = false) {
    const int call = ++devtools_id_;
    devtools_pending_[call] = {reply, evaluate};
    if (!browser->GetHost()->ExecuteDevToolsMethod(call, method, params)) {
      devtools_pending_.erase(call);
      reply->Error("DevTools method rejected");
      return;
    }
    CefRefPtr<Client> self(this);
    CefPostDelayedTask(TID_UI, new Task([self, call] {
                         auto found = self->devtools_pending_.find(call);
                         if (found == self->devtools_pending_.end())
                           return;
                         auto reply = found->second.first;
                         self->devtools_pending_.erase(found);
                         reply->Error("DevTools call timed out");
                       }),
                       10000);
  }
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>, int message_id,
                              bool success, const void *result,
                              size_t size) override {
    auto found = devtools_pending_.find(message_id);
    if (found == devtools_pending_.end())
      return;
    auto [reply, evaluate] = found->second;
    devtools_pending_.erase(found);
    std::string json(static_cast<const char *>(result), size);
    auto response = Parse(json.c_str());
    if (!success || !response) {
      reply->Error("DevTools call failed");
      return;
    }
    if (evaluate) {
      if (response->HasKey("exceptionDetails")) {
        reply->Error("JavaScript evaluation threw");
        return;
      }
      auto remote = response->GetDictionary("result");
      auto value = Object();
      if (remote && remote->HasKey("value"))
        value->SetValue("value", remote->GetValue("value"));
      else
        value->SetNull("value");
      if (remote && remote->HasKey("unserializableValue"))
        value->SetString("unserializableValue",
                         remote->GetString("unserializableValue"));
      reply->Send(value);
    } else
      reply->Send(response);
  }
  void OnDevToolsAgentDetached(CefRefPtr<CefBrowser>) override {
    FailDevTools("DevTools agent detached");
  }

private:
  void FailDevTools(const char *error) {
    auto pending = std::move(devtools_pending_);
    devtools_pending_.clear();
    for (const auto &entry : pending)
      entry.second.first->Error(error);
  }
  int id_;
  int devtools_id_ = 0;
  std::map<int, std::pair<std::shared_ptr<Reply>, bool>> devtools_pending_;
  CefRefPtr<CefRegistration> devtools_registration_;
  IMPLEMENT_REFCOUNTING(Client);
};

class App final : public CefApp, public CefBrowserProcessHandler {
public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }
  void OnContextInitialized() override {
    SetEngineSink(true);
    g_phase = Phase::kReady;
    Emit("engine.ready", Object());
  }
  void OnScheduleMessagePumpWork(int64_t delay_ms) override {
    auto d = Object();
    d->SetDouble("delayMs", static_cast<double>(delay_ms));
    Emit("engine.schedulePump", d);
  }
  void OnBeforeCommandLineProcessing(
      const CefString &process_type,
      CefRefPtr<CefCommandLine> command_line) override {
    if (process_type.empty()) {
      command_line->AppendSwitch("no-first-run");
      command_line->AppendSwitch("no-default-browser-check");
    }
  }

private:
  IMPLEMENT_REFCOUNTING(App);
};
CefRefPtr<App> g_app;

bool AbsolutePath(const std::string &input, std::filesystem::path &result) {
  if (input.empty())
    return false;
  result =
      std::filesystem::path(CefString(input).ToWString()).lexically_normal();
  return result.is_absolute();
}
HWND Parent(Dict d) {
  const std::string text = String(d, "parent");
  uintptr_t value = 0;
  const auto parsed =
      std::from_chars(text.data(), text.data() + text.size(), value);
  if (text.empty() || parsed.ec != std::errc() ||
      parsed.ptr != text.data() + text.size())
    return nullptr;
  HWND hwnd = reinterpret_cast<HWND>(value);
  DWORD process = 0;
  GetWindowThreadProcessId(hwnd, &process);
  return IsWindow(hwnd) && process == GetCurrentProcessId() ? hwnd : nullptr;
}
CefRefPtr<CefRequestContext> Context(Dict args, std::shared_ptr<Reply> reply) {
  const bool private_profile = Bool(args, "private");
  auto profile = String(args, "profile");
  if (profile.empty() && !private_profile)
    return CefRequestContext::GetGlobalContext();
  auto existing = g_profiles.find(profile);
  if (existing != g_profiles.end())
    return existing->second;
  if (!private_profile) {
    std::filesystem::path path;
    if (!AbsolutePath(profile, path)) {
      reply->Error("profile must be an absolute directory");
      return nullptr;
    }
    // CEF requires every profile cache below root_cache_path. Never let a web
    // page or malformed bridge call open another application's profile.
    auto root = g_root_cache.native();
    auto candidate = path.native();
    if (candidate.size() <= root.size() ||
        _wcsnicmp(candidate.c_str(), root.c_str(), root.size()) != 0 ||
        (candidate[root.size()] != L'\\' && candidate[root.size()] != L'/')) {
      reply->Error("profile must be inside Bay's cachePath");
      return nullptr;
    }
    auto found = g_profiles.find(profile);
    if (found != g_profiles.end())
      return found->second;
  }
  CefRequestContextSettings settings;
  if (!private_profile)
    CefString(&settings.cache_path) = profile;
  settings.persist_session_cookies = private_profile ? 0 : 1;
  auto context = CefRequestContext::CreateContext(settings, nullptr);
  if (context)
    g_profiles[profile] = context;
  return context;
}

void Dispatch(const std::string &method, Dict args,
              std::shared_ptr<Reply> reply) {
  if (method == "engine.info") {
    auto d = Object();
    d->SetInt("abi", NNCORE_C_ABI_VERSION);
    d->SetString("engine", "CEF/" CEF_VERSION);
    d->SetString("messageLoop", g_external_pump ? "external" : "threaded");
    reply->Send(d);
    return;
  }
  if (method == "engine.close") {
    g_phase = Phase::kClosing;
    // Close callbacks may synchronously remove a map entry.
    std::vector<CefRefPtr<CefBrowser>> browsers;
    for (const auto &entry : g_browsers)
      browsers.push_back(entry.second);
    for (const auto &browser : browsers)
      browser->GetHost()->CloseBrowser(Bool(args, "force"));
    reply->Ok();
    ReadyToShutdown();
    return;
  }
  if (g_phase != Phase::kReady) {
    reply->Error("engine is closing");
    return;
  }
  if (method == "engine.call") {
    auto name = String(args, "name");
    if (!bay::IsEngineCall(name)) {
      reply->Error("invalid engine call name");
      return;
    }
    using Call = void (*)(const char *, const char *, nncore_reply_t, void *);
    auto library = GetModuleHandleW(L"libcef.dll");
    auto call =
        library ? reinterpret_cast<Call>(GetProcAddress(library, name.c_str()))
                : nullptr;
    if (!call) {
      reply->Error("engine call unavailable");
      return;
    }
    const auto profile = String(args, "profile");
    auto argument_value = args->GetValue("args");
    std::string json =
        argument_value && argument_value->GetType() == VTYPE_DICTIONARY
            ? JSON(argument_value->GetDictionary())
            : String(args, "args");
    // Ownership transfers to the asynchronous nn_* reply; no stack pointer or
    // pointer to a temporary crosses the C ABI.
    const uintptr_t token = ++g_next_call;
    g_engine_calls[token] = reply;
    call(
        profile.c_str(), json.empty() ? nullptr : json.c_str(),
        [](void *context, const char *response) {
          auto found =
              g_engine_calls.find(reinterpret_cast<uintptr_t>(context));
          if (found == g_engine_calls.end())
            return;
          auto reply = found->second;
          g_engine_calls.erase(found);
          reply->Forward(response);
        },
        reinterpret_cast<void *>(token));
    return;
  }
  if (method == "permission.resolve") {
    const auto text = String(args, "id");
    uint64_t id = 0;
    const auto parsed =
        std::from_chars(text.data(), text.data() + text.size(), id);
    auto found = g_permissions.find(id);
    if (text.empty() || parsed.ec != std::errc() ||
        parsed.ptr != text.data() + text.size() ||
        found == g_permissions.end()) {
      reply->Error("permission request no longer exists");
      return;
    }
    const auto result = String(args, "result");
    if (result != "accept" && result != "deny" && result != "dismiss") {
      reply->Error("invalid permission result");
      return;
    }
    auto callback = found->second;
    g_permissions.erase(found);
    callback->Continue(result == "accept" ? CEF_PERMISSION_RESULT_ACCEPT
                       : result == "deny" ? CEF_PERMISSION_RESULT_DENY
                                          : CEF_PERMISSION_RESULT_DISMISS);
    reply->Ok();
    return;
  }
  const int id = Int(args, "id");
  if (method == "tab.create") {
    if (id <= 0 || g_browsers.count(id)) {
      reply->Error("tab id must be positive and unique");
      return;
    }
    HWND parent = Parent(args);
    const int width = Int(args, "width");
    const int height = Int(args, "height");
    if (!parent || width <= 0 || height <= 0) {
      reply->Error("valid parent HWND and positive dimensions required");
      return;
    }
    auto context = Context(args, reply);
    if (!context)
      return;
    CefWindowInfo window;
    window.SetAsChild(parent,
                      CefRect(Int(args, "x"), Int(args, "y"), width, height));
    window.runtime_style = CEF_RUNTIME_STYLE_CHROME;
    CefBrowserSettings settings;
    settings.client_window = STATE_ENABLED;
    settings.native_contents_hosting = STATE_ENABLED;
    const auto url = String(args, "url");
    auto browser = CefBrowserHost::CreateBrowserSync(
        window, new Client(id), url.empty() ? "about:blank" : url, settings,
        nullptr, context);
    if (!browser) {
      reply->Error("could not create browser");
      return;
    }
    ShowWindow(browser->GetHost()->GetWindowHandle(),
               Bool(args, "visible", true) ? SW_SHOWNA : SW_HIDE);
    reply->Send(WithId(id));
    return;
  }
  auto found = g_browsers.find(id);
  if (found == g_browsers.end()) {
    reply->Error("no such tab");
    return;
  }
  auto browser = found->second;
  auto host = browser->GetHost();
  if (method == "tab.close")
    host->CloseBrowser(Bool(args, "force"));
  else if (method == "tab.focus")
    host->SetFocus(true);
  else if (method == "tab.navigate") {
    auto url = String(args, "url");
    if (url.empty()) {
      reply->Error("url required");
      return;
    }
    browser->GetMainFrame()->LoadURL(url);
  } else if (method == "tab.back")
    browser->GoBack();
  else if (method == "tab.forward")
    browser->GoForward();
  else if (method == "tab.reload") {
    if (Bool(args, "bypassCache"))
      browser->ReloadIgnoreCache();
    else
      browser->Reload();
  } else if (method == "tab.stop")
    browser->StopLoad();
  else if (method == "tab.bounds") {
    int width = Int(args, "width"), height = Int(args, "height");
    if (width < 0 || height < 0) {
      reply->Error("negative browser bounds");
      return;
    }
    if (!SetWindowPos(host->GetWindowHandle(), nullptr, Int(args, "x"),
                      Int(args, "y"), width, height,
                      SWP_NOACTIVATE | SWP_NOZORDER)) {
      reply->Error("could not resize browser HWND");
      return;
    }
    host->NotifyMoveOrResizeStarted();
  } else if (method == "tab.parent") {
    HWND parent = Parent(args);
    if (!parent) {
      reply->Error("valid parent HWND required");
      return;
    }
    SetLastError(ERROR_SUCCESS);
    if (!SetParent(host->GetWindowHandle(), parent) &&
        GetLastError() != ERROR_SUCCESS) {
      reply->Error("could not reparent browser HWND");
      return;
    }
  } else if (method == "tab.evaluate") {
    auto params = Object();
    params->SetString("expression", String(args, "code"));
    params->SetBool("returnByValue", true);
    params->SetBool("awaitPromise", true);
    params->SetBool("userGesture", Bool(args, "userGesture"));
    g_clients[id]->DevTools(browser, "Runtime.evaluate", params, reply, true);
    return;
  } else if (method == "tab.setFrozen") {
    auto params = Object();
    params->SetString("state", Bool(args, "frozen") ? "frozen" : "active");
    g_clients[id]->DevTools(browser, "Page.setWebLifecycleState", params,
                            reply);
    return;
  } else if (method == "tab.devtoolsCall") {
    auto params = args->GetDictionary("params");
    g_clients[id]->DevTools(browser, String(args, "method"),
                            params ? params : Object(), reply);
    return;
  } else if (method == "tab.props") {
    auto props = args->GetDictionary("props");
    if (!props) {
      reply->Error("props required");
      return;
    }
    const bool visible = !Bool(props, "hidden") && Bool(props, "visible", true);
    ShowWindow(host->GetWindowHandle(), visible ? SW_SHOWNA : SW_HIDE);
    if (props->HasKey("muted"))
      host->SetAudioMuted(Bool(props, "muted"));
    auto url = String(props, "url");
    if (!url.empty() && url != browser->GetMainFrame()->GetURL())
      browser->GetMainFrame()->LoadURL(url);
  } else if (method == "tab.visible")
    ShowWindow(host->GetWindowHandle(),
               Bool(args, "visible") ? SW_SHOWNA : SW_HIDE);
  else if (method == "tab.zoom")
    host->SetZoomLevel(args->GetDouble("level"));
  else if (method == "tab.mute")
    host->SetAudioMuted(Bool(args, "muted"));
  else if (method == "tab.execute")
    browser->GetMainFrame()->ExecuteJavaScript(
        String(args, "code"), browser->GetMainFrame()->GetURL(), 0);
  else if (method == "tab.print")
    host->Print();
  else if (method == "tab.find")
    host->Find(String(args, "text"), Bool(args, "forward", true),
               Bool(args, "matchCase"), Bool(args, "findNext"));
  else if (method == "tab.stopFind")
    host->StopFinding(Bool(args, "clearSelection", true));
  else if (method == "tab.devtools") {
    if (Bool(args, "open", true)) {
      CefWindowInfo window;
      window.SetAsPopup(nullptr, "Bay DevTools");
      host->ShowDevTools(window, nullptr, CefBrowserSettings(), CefPoint());
    } else
      host->CloseDevTools();
  } else {
    reply->Error("unknown method");
    return;
  }
  reply->Ok();
}
} // namespace

extern "C" NNCORE_C_EXPORT int nncore_abi_version() {
  return NNCORE_C_ABI_VERSION;
}
extern "C" NNCORE_C_EXPORT void nncore_set_event_sink(nncore_event_t sink,
                                                      void *context) {
  std::lock_guard<std::mutex> lock(g_sink_mutex);
  g_sink = sink;
  g_sink_context = context;
}

extern "C" NNCORE_C_EXPORT int
nncore_initialize_with_sandbox(const char *options_json, void *sandbox_info) {
  if (g_phase != Phase::kNew)
    return -1;
  auto options = Parse(options_json);
  if (!options || !AbsolutePath(String(options, "cachePath"), g_root_cache))
    return -1;
  std::filesystem::path subprocess;
  if (!AbsolutePath(String(options, "subprocessPath"), subprocess) ||
      !std::filesystem::exists(subprocess))
    return -1;
  const auto loop = String(options, "messageLoop");
  if (!loop.empty() && loop != "external" && loop != "threaded")
    return -1;
  if (!sandbox_info && !Bool(options, "allowUnsafeNoSandbox"))
    return -1;
  const int port = Int(options, "remoteDebuggingPort");
  if (port && (port < 1024 || port > 65535))
    return -1;
  g_initialization_thread = GetCurrentThreadId();
  g_external_pump = loop != "threaded";
  CefSettings settings;
  settings.no_sandbox = sandbox_info ? 0 : 1;
  settings.multi_threaded_message_loop = g_external_pump ? 0 : 1;
  settings.external_message_pump = g_external_pump ? 1 : 0;
  CefString(&settings.root_cache_path) = g_root_cache.native();
  CefString(&settings.cache_path) = (g_root_cache / L"Default").native();
  CefString(&settings.browser_subprocess_path) = subprocess.native();
  CefString(&settings.resources_dir_path) = String(options, "resourcesPath");
  CefString(&settings.locales_dir_path) = String(options, "localesPath");
  settings.persist_session_cookies = 1;
  settings.remote_debugging_port = port;
  g_app = new App();
  g_phase = Phase::kStarting;
  if (!CefInitialize(CefMainArgs(GetModuleHandleW(nullptr)), settings, g_app,
                     sandbox_info)) {
    g_app = nullptr;
    g_phase = Phase::kStopped;
    return 0;
  }
  return 1;
}
extern "C" NNCORE_C_EXPORT int nncore_execute_process(void *sandbox_info) {
  return CefExecuteProcess(CefMainArgs(GetModuleHandleW(nullptr)), nullptr,
                           sandbox_info);
}
extern "C" NNCORE_C_EXPORT int nncore_initialize(const char *options_json) {
  return nncore_initialize_with_sandbox(options_json, nullptr);
}
extern "C" NNCORE_C_EXPORT void nncore_do_message_loop_work() {
  if (g_external_pump && GetCurrentThreadId() == g_initialization_thread &&
      g_phase != Phase::kNew && g_phase != Phase::kStopped)
    CefDoMessageLoopWork();
}
extern "C" NNCORE_C_EXPORT int nncore_shutdown() {
  if (GetCurrentThreadId() != g_initialization_thread)
    return -1;
  if (g_phase == Phase::kStopped)
    return 1;
  if (g_phase != Phase::kClosing || g_browser_count != 0)
    return 0;
  SetEngineSink(false);
  CefShutdown();
  g_app = nullptr;
  g_phase = Phase::kStopped;
  return 1;
}
extern "C" NNCORE_C_EXPORT void nncore_call(const char *method,
                                            const char *args_json,
                                            nncore_reply_t callback,
                                            void *context) {
  auto reply = std::make_shared<Reply>(callback, context);
  if (!method || !*method) {
    reply->Error("method required");
    return;
  }
  if (g_phase != Phase::kReady && g_phase != Phase::kClosing) {
    reply->Error("engine not ready");
    return;
  }
  auto args = Parse(args_json);
  if (!args) {
    reply->Error("arguments must be a JSON object");
    return;
  }
  OnUI([name = std::string(method), args,
        reply] { Dispatch(name, args, reply); },
       reply);
}
