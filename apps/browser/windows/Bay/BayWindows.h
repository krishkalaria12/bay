#pragma once
#include "NativeModules.h"
#include "WindowsHost.h"
#include <ReactContext.h>
#include <ReactPromise.h>
#include <thread>

inline winrt::Microsoft::ReactNative::JSValue
ToJSValue(bay::Json const &value) {
  using namespace winrt::Microsoft::ReactNative;
  using winrt::Windows::Data::Json::JsonValueType;
  switch (value.ValueType()) {
  case JsonValueType::String:
    return JSValue(bay::Text(value));
  case JsonValueType::Number:
    return JSValue(value.GetNumber());
  case JsonValueType::Boolean:
    return JSValue(value.GetBoolean());
  case JsonValueType::Array: {
    JSValueArray array;
    for (auto const &item : value.GetArray())
      array.push_back(ToJSValue(item));
    return JSValue(std::move(array));
  }
  case JsonValueType::Object: {
    JSValueObject object;
    for (auto const &item : value.GetObject())
      object.emplace(winrt::to_string(item.Key()), ToJSValue(item.Value()));
    return JSValue(std::move(object));
  }
  default:
    return JSValue(nullptr);
  }
}
REACT_MODULE(BayWindows, L"BayWindows")
struct BayWindows {
  winrt::Microsoft::ReactNative::ReactContext context;
  REACT_INIT(Initialize)
  void Initialize(
      winrt::Microsoft::ReactNative::ReactContext const &value) noexcept {
    context = value;
    bay::SetEventSink([value](std::string const &module,
                              std::string const &event,
                              bay::Json const &payload) {
      value.EmitJSEvent(L"RCTDeviceEventEmitter",
                        winrt::to_hstring(module + "." + event),
                        ToJSValue(payload));
    });
  }
  REACT_CONSTANT_PROVIDER(Constants)
  void Constants(winrt::Microsoft::ReactNative::ReactConstantProvider
                     &constants) noexcept {
    constants.Add(L"contractVersion", 1);
    constants.Add(L"modules", std::vector<std::string>{
                                  "BayShell", "BayApp", "BaySystem",
                                  "BayKeychain", "BayCEF", "BayChromeUI",
                                  "BayExtensions", "BayImport", "BaySync"});
    constants.Add(L"optionalMethods",
                  std::vector<std::string>{"BayShell.windowFrame",
                                           "BaySystem.downloadsFolder"});
    constants.Add(L"views", std::vector<std::string>{});
    constants.Add(L"synchronousMethods",
                  std::vector<std::string>{
                      "BayShell.readDocument", "BayShell.writeDocument",
                      "BayShell.removeDocument", "BayShell.copyText",
                      "BayShell.copyImage", "BaySystem.fileExists",
                      "BaySystem.downloadsFolder", "BaySystem.hapticTick",
                      "BayApp.systemInfo", "BayApp.launchEnvironment"});
    constants.Add(L"constantsJSON",
                  std::string(R"({"BayApp":{"apiVersion":9}})"));
  }
  REACT_SYNC_METHOD(InvokeSync, L"invokeSync")
  std::string InvokeSync(std::string const &module, std::string const &method,
                         std::string const &args) noexcept {
    return bay::Invoke(module, method, args);
  }
  REACT_METHOD(Invoke, L"invoke")
  void Invoke(std::string module, std::string method, std::string args,
              winrt::Microsoft::ReactNative::ReactPromise<std::string>
                  promise) noexcept {
    const bool worker =
        (module == "BayImport" && method != "chooseImportFile") ||
        (module == "BaySync" && method != "chooseFolder" &&
         method != "saveRecoveryKit" && method != "copyRecoveryKit" &&
         method != "copyRecoveryPhrase" && method != "shareRecoveryKit");
    auto work = [module = std::move(module), method = std::move(method),
                 args = std::move(args), promise]() {
      promise.Resolve(bay::Invoke(module, method, args));
    };
    if (worker) {
      std::thread([work = std::move(work), promise]() {
        try {
          winrt::init_apartment(winrt::apartment_type::multi_threaded);
          work();
          winrt::uninit_apartment();
        } catch (winrt::hresult_error const &error) {
          promise.Reject(winrt::to_string(error.message()));
        }
      }).detach();
    } else
      context.UIDispatcher().Post(std::move(work));
  }
  REACT_METHOD(AddListener, L"addListener")
  void AddListener(std::string const &) noexcept {}
  REACT_METHOD(RemoveListeners, L"removeListeners")
  void RemoveListeners(double) noexcept {}
};
