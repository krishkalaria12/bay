#include "WindowsHost.h"
#include "nncore_c.h"
#include "pch.h"
#include <chrono>
#include <condition_variable>
#include <map>
#include <mutex>
#include <stdexcept>

namespace bay {
namespace {
HMODULE library = nullptr;
void *g_sandboxInfo = nullptr;
bool initialized = false;
decltype(&nncore_initialize) initialize = nullptr;
decltype(&nncore_call) call = nullptr;
decltype(&nncore_shutdown) shutdown = nullptr;
decltype(&nncore_set_event_sink) setSink = nullptr;
std::map<int, Object> views;
std::mutex readyMutex;
std::condition_variable readyCondition;
bool ready = false;
std::map<int, Object> navigation;
struct Reply {
  std::mutex mutex;
  std::condition_variable condition;
  bool complete = false;
  std::string value;
};
std::string Call(std::string const &method, Object const &arguments) {
  // CEF runs its UI loop on its own thread. No application UI work can depend
  // on this callback.
  auto reply = new std::shared_ptr<Reply>(std::make_shared<Reply>());
  auto state = *reply;
  call(
      method.c_str(), winrt::to_string(arguments.Stringify()).c_str(),
      [](void *context, char const *json) {
        auto holder = static_cast<std::shared_ptr<Reply> *>(context);
        auto state = *holder;
        delete holder;
        {
          std::lock_guard<std::mutex> lock(state->mutex);
          state->value = json ? json : "null";
          state->complete = true;
        }
        state->condition.notify_one();
      },
      reply);
  std::unique_lock<std::mutex> lock(state->mutex);
  if (!state->condition.wait_for(lock, std::chrono::seconds(30),
                                 [&] { return state->complete; }))
    throw std::runtime_error("Engine request timed out: " + method);
  auto result = winrt::Windows::Data::Json::JsonValue::Parse(
      winrt::to_hstring(state->value));
  if (result.ValueType() == winrt::Windows::Data::Json::JsonValueType::Object &&
      result.GetObject().HasKey(L"error"))
    throw std::runtime_error(state->value);
  return state->value;
}
void EngineEvent(void *, char const *topic, char const *payload) {
  std::string name = topic ? topic : "";
  auto value = winrt::Windows::Data::Json::JsonValue::Parse(
      winrt::to_hstring(payload ? payload : "null"));
  if (name == "engine.ready") {
    {
      std::lock_guard<std::mutex> lock(readyMutex);
      ready = true;
    }
    readyCondition.notify_all();
  }
  if (name == "engine.event" &&
      value.ValueType() == winrt::Windows::Data::Json::JsonValueType::Object) {
    auto wrapped = value.GetObject();
    name = winrt::to_string(wrapped.GetNamedString(L"topic", L""));
    value = winrt::Windows::Data::Json::JsonValue::Parse(
        wrapped.GetNamedString(L"payload", L"{}"));
  }
  if (value.ValueType() == winrt::Windows::Data::Json::JsonValueType::Object) {
    auto object = value.GetObject();
    if (object.HasKey(L"profile") &&
        object.GetNamedValue(L"profile").ValueType() ==
            winrt::Windows::Data::Json::JsonValueType::String) {
      auto path =
          std::filesystem::path(object.GetNamedString(L"profile").c_str());
      auto name = path.filename().wstring();
      object.SetNamedValue(L"profile",
                           String(_wcsicmp(name.c_str(), L"Default") == 0
                                      ? ""
                                      : winrt::to_string(name)));
    }
  }
  const auto eventJSON = winrt::to_string(value.Stringify());
  Object event;
  event.SetNamedValue(L"topic", String(name));
  event.SetNamedValue(L"payload", String(eventJSON));
  Emit("BayCEF", "onEngineEvent", event);
  if (value.ValueType() != winrt::Windows::Data::Json::JsonValueType::Object)
    return;
  auto object = value.GetObject();
  if (!object.HasKey(L"id"))
    return;
  auto id = object.GetNamedValue(L"id");
  int tag = 0;
  if (id.ValueType() == winrt::Windows::Data::Json::JsonValueType::Number)
    tag = int(id.GetNumber());
  else if (id.ValueType() ==
           winrt::Windows::Data::Json::JsonValueType::String) {
    try {
      tag = std::stoi(Text(id));
    } catch (...) {
      return;
    }
  }
  Object viewEvent;
  viewEvent.SetNamedValue(L"tag", Number(tag));
  viewEvent.SetNamedValue(L"payload", value);
  if (name == "tab.created")
    viewEvent.SetNamedValue(L"event", String("onReady"));
  else if (name == "tab.changed") {
    auto &state = navigation[tag];
    if (!state.HasKey(L"url")) {
      state.SetNamedValue(L"url", String("about:blank"));
      state.SetNamedValue(L"title", String(""));
      state.SetNamedValue(L"isLoading", Boolean(false));
      state.SetNamedValue(L"canGoBack", Boolean(false));
      state.SetNamedValue(L"canGoForward", Boolean(false));
      state.SetNamedValue(L"themeColor", Null());
      state.SetNamedValue(L"themeColorSource", Null());
    }
    for (auto const &entry : object) {
      if (entry.Key() == L"loading")
        state.SetNamedValue(L"isLoading", entry.Value());
      else
        state.SetNamedValue(entry.Key(), entry.Value());
    }
    if (object.HasKey(L"errorCode")) {
      viewEvent.SetNamedValue(L"event", String("onLoadError"));
      Object error;
      error.SetNamedValue(L"code", object.GetNamedValue(L"errorCode"));
      error.SetNamedValue(L"description", object.GetNamedValue(L"error"));
      error.SetNamedValue(L"url", state.GetNamedValue(L"url"));
      viewEvent.SetNamedValue(L"payload", error);
    } else if (object.HasKey(L"favicon")) {
      viewEvent.SetNamedValue(L"event", String("onFavicon"));
      Object favicon;
      favicon.SetNamedValue(L"url", object.GetNamedValue(L"favicon"));
      Array urls;
      urls.Append(object.GetNamedValue(L"favicon"));
      favicon.SetNamedValue(L"urls", urls);
      viewEvent.SetNamedValue(L"payload", favicon);
    } else {
      viewEvent.SetNamedValue(L"event", String("onNavigationChange"));
      viewEvent.SetNamedValue(L"payload", Object::Parse(state.Stringify()));
    }
  } else if (name == "tab.findResult")
    viewEvent.SetNamedValue(L"event", String("onFindResult"));
  else if (name == "tab.popup") {
    viewEvent.SetNamedValue(L"event", String("onOpenWindow"));
    object.SetNamedValue(L"disposition", String("popup"));
    viewEvent.SetNamedValue(L"payload", object);
  } else if (name == "tab.closed") {
    navigation.erase(tag);
    viewEvent.SetNamedValue(L"event", String("onWindowClose"));
  } else
    return;
  Emit("BayCEF", "onViewEvent", viewEvent);
}
template <class T> T Export(char const *name) {
  auto address = GetProcAddress(library, name);
  if (!address)
    throw std::runtime_error(std::string("Missing NNCore.dll export: ") + name);
  return reinterpret_cast<T>(address);
}
void EnsureEngine() {
  if (initialized)
    return;
  auto path = ExecutableDirectory() / L"NNCore.dll";
  if (!library)
    library = LoadLibraryExW(path.c_str(), nullptr,
                             LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
                                 LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (!library)
    winrt::throw_last_error();
  try {
    auto version = Export<decltype(&nncore_abi_version)>("nncore_abi_version");
    if (version() != NNCORE_C_ABI_VERSION)
      throw std::runtime_error("NNCore.dll ABI does not match the application");
    initialize = Export<decltype(initialize)>("nncore_initialize");
    call = Export<decltype(call)>("nncore_call");
    shutdown = Export<decltype(shutdown)>("nncore_shutdown");
    setSink = Export<decltype(setSink)>("nncore_set_event_sink");
    setSink(EngineEvent, nullptr);
    Object options;
    options.SetNamedValue(
        L"cachePath",
        String(winrt::to_string((DataDirectory() / L"Engine").wstring())));
    options.SetNamedValue(
        L"resourcesPath",
        String(winrt::to_string(ExecutableDirectory().wstring())));
    options.SetNamedValue(L"localesPath",
                          String(winrt::to_string(
                              (ExecutableDirectory() / L"locales").wstring())));
    options.SetNamedValue(
        L"subprocessPath",
        String(winrt::to_string(
            (ExecutableDirectory() / L"nncore_subprocess.exe").wstring())));
    options.SetNamedValue(L"messageLoop", String("threaded"));
    if (Export<decltype(&nncore_initialize_with_sandbox)>(
            "nncore_initialize_with_sandbox")(
            winrt::to_string(options.Stringify()).c_str(), g_sandboxInfo) != 1)
      throw std::runtime_error("CEF initialization failed; verify signed "
                               "engine files and sandbox bootstrap");
    std::unique_lock<std::mutex> lock(readyMutex);
    if (!readyCondition.wait_for(lock, std::chrono::seconds(30),
                                 [] { return ready; }))
      throw std::runtime_error("CEF initialization timed out");
    initialized = true;
  } catch (...) {
    throw;
  }
}
Object TagArguments(int tag) {
  Object result;
  result.SetNamedValue(L"id", Number(tag));
  return result;
}
} // namespace
Json InvokeEngine(std::string const &method, Array const &args) {
  EnsureEngine();
  if (method == "mount") {
    int tag = int(args.GetNumberAt(0));
    auto props = args.Size() > 8 ? args.GetObjectAt(8) : Object();
    auto windowId = winrt::to_string(props.GetNamedString(L"windowId", L""));
    auto parent = WindowHandle(windowId);
    if (!parent)
      throw std::runtime_error(
          "Cannot mount browser without its owning window");
    auto request = TagArguments(tag);
    request.SetNamedValue(
        L"parent", String(std::to_string(reinterpret_cast<uintptr_t>(parent))));
    request.SetNamedValue(L"url", args.GetAt(1));
    auto profile = ArgText(args, 2);
    const bool privateProfile = profile.rfind("incognito:", 0) == 0;
    if (!privateProfile &&
        (profile.find_first_of("/\\:") != std::string::npos || profile == "." ||
         profile == ".."))
      throw std::invalid_argument("Invalid profile id");
    request.SetNamedValue(
        L"profile",
        String(privateProfile ? profile
               : profile.empty()
                   ? ""
                   : winrt::to_string((DataDirectory() / L"Engine" /
                                       winrt::to_hstring(profile).c_str())
                                          .wstring())));
    request.SetNamedValue(L"private", Boolean(privateProfile));
    request.SetNamedValue(L"visible",
                          Boolean(props.GetNamedBoolean(L"visible", true)));
    const auto scale = GetDpiForWindow(parent) / 96.0;
    for (unsigned i = 0; i < 4; ++i)
      request.SetNamedValue(i == 0   ? L"x"
                            : i == 1 ? L"y"
                            : i == 2 ? L"width"
                                     : L"height",
                            Number(args.GetNumberAt(i + 3) * scale));
    views[tag] = props;
    return winrt::Windows::Data::Json::JsonValue::Parse(
        winrt::to_hstring(Call("tab.create", request)));
  }
  if (method == "bounds") {
    int tag = int(args.GetNumberAt(0));
    auto request = TagArguments(tag);
    auto found = views.find(tag);
    auto parent = WindowHandle(
        found == views.end()
            ? ""
            : winrt::to_string(found->second.GetNamedString(L"windowId", L"")));
    const auto scale = parent ? GetDpiForWindow(parent) / 96.0 : 1.0;
    for (unsigned i = 0; i < 4; ++i)
      request.SetNamedValue(i == 0   ? L"x"
                            : i == 1 ? L"y"
                            : i == 2 ? L"width"
                                     : L"height",
                            Number(args.GetNumberAt(i + 1) * scale));
    return winrt::Windows::Data::Json::JsonValue::Parse(
        winrt::to_hstring(Call("tab.bounds", request)));
  }
  if (method == "unmount") {
    int tag = int(args.GetNumberAt(0));
    auto result = Call("tab.close", TagArguments(tag));
    views.erase(tag);
    return winrt::Windows::Data::Json::JsonValue::Parse(
        winrt::to_hstring(result));
  }
  if (method == "updateProps") {
    int tag = int(args.GetNumberAt(0));
    views[tag] = args.GetObjectAt(1);
    auto request = TagArguments(tag);
    request.SetNamedValue(L"props", args.GetAt(1));
    return winrt::Windows::Data::Json::JsonValue::Parse(
        winrt::to_hstring(Call("tab.props", request)));
  }
  if (method == "engineCall") {
    auto payload = ArgText(args, 2, "{}");
    return String(
        winrt::to_string(EngineCall(ArgText(args, 0), ArgText(args, 1),
                                    Object::Parse(winrt::to_hstring(payload)))
                             .Stringify()));
  }
  if (method == "viewCall") {
    int tag = int(args.GetNumberAt(0));
    auto name = ArgText(args, 1);
    auto values = args.GetArrayAt(2);
    auto request = TagArguments(tag);
    if (name == "loadUrl") {
      request.SetNamedValue(L"url", values.GetAt(0));
      name = "navigate";
    } else if (name == "goBack")
      name = "back";
    else if (name == "goForward")
      name = "forward";
    else if (name == "stopLoading")
      name = "stop";
    else if (name == "showDevTools") {
      name = "devtools";
      request.SetNamedValue(L"open", Boolean(true));
    } else if (name == "forceReload") {
      name = "reload";
      request.SetNamedValue(L"bypassCache", Boolean(true));
    } else if (name == "find") {
      request.SetNamedValue(L"text", values.GetAt(0));
      request.SetNamedValue(L"forward", values.GetAt(1));
      request.SetNamedValue(L"findNext", values.GetAt(2));
    }
    if (name == "setMuted") {
      name = "mute";
      request.SetNamedValue(L"muted", values.GetAt(0));
    } else if (name == "executeJavaScript") {
      name = "execute";
      request.SetNamedValue(L"code", values.GetAt(0));
    } else if (name == "evaluate")
      request.SetNamedValue(L"code", values.GetAt(0));
    else if (name == "setFrozen")
      request.SetNamedValue(L"frozen", values.GetAt(0));
    else if (name == "stopFinding") {
      name = "stopFind";
      request.SetNamedValue(L"clearSelection", values.GetAt(0));
    }
    request.SetNamedValue(L"args", values);
    return winrt::Windows::Data::Json::JsonValue::Parse(
        winrt::to_hstring(Call("tab." + name, request)));
  }
  Object request;
  request.SetNamedValue(L"args", args);
  return winrt::Windows::Data::Json::JsonValue::Parse(
      winrt::to_hstring(Call("module." + method, request)));
}
int PrepareEngineProcess(void *sandboxInfo) {
  if (!sandboxInfo)
    throw std::runtime_error(
        "Bay must be launched through the CEF sandbox bootstrap");
  g_sandboxInfo = sandboxInfo;
  auto path = ExecutableDirectory() / L"NNCore.dll";
  library = LoadLibraryExW(path.c_str(), nullptr,
                           LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
                               LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (!library)
    winrt::throw_last_error();
  return Export<decltype(&nncore_execute_process)>("nncore_execute_process")(
      sandboxInfo);
}
Json EngineCall(std::string const &name, std::string const &profile,
                Object const &arguments) {
  EnsureEngine();
  if (profile.rfind("incognito", 0) == 0)
    throw std::invalid_argument(
        "Persistent engine data is unavailable for a private profile");
  if (profile.find_first_of("/\\:") != std::string::npos || profile == "." ||
      profile == "..")
    throw std::invalid_argument("Invalid profile name");
  Object request;
  request.SetNamedValue(L"name", String(name));
  request.SetNamedValue(
      L"profile",
      String(winrt::to_string(
          (DataDirectory() / L"Engine" /
           (profile.empty() ? L"Default" : winrt::to_hstring(profile).c_str()))
              .wstring())));
  request.SetNamedValue(L"args", arguments);
  return winrt::Windows::Data::Json::JsonValue::Parse(
      winrt::to_hstring(Call("engine.call", request)));
}
void ShutdownEngine() {
  if (!initialized || !shutdown)
    return;
  Object request;
  Call("engine.close", request);
  // A successful shutdown is required before either engine DLL can unload.
  for (int attempt = 0; attempt < 300; ++attempt) {
    int status = shutdown();
    if (status == 1)
      return;
    if (status < 0)
      throw std::runtime_error("CEF shutdown was called on the wrong thread");
    Sleep(10);
  }
  throw std::runtime_error("CEF still has live browsers during shutdown");
}
} // namespace bay
