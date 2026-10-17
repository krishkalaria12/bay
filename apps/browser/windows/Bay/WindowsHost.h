#pragma once
#include <filesystem>
#include <functional>
#include <string>
#include <windows.h>
#include <winrt/Microsoft.ReactNative.h>
#include <winrt/Microsoft.UI.Composition.h>
#include <winrt/Windows.Data.Json.h>

namespace bay {
using Json = winrt::Windows::Data::Json::IJsonValue;
using Object = winrt::Windows::Data::Json::JsonObject;
using Array = winrt::Windows::Data::Json::JsonArray;
using EventSink =
    std::function<void(std::string const &, std::string const &, Json const &)>;
std::filesystem::path DataDirectory();
std::filesystem::path ExecutableDirectory();
void ConfigureHost(
    winrt::Microsoft::ReactNative::ReactNativeHost const &host,
    winrt::Microsoft::UI::Composition::Compositor const &compositor);
void SetEventSink(EventSink sink);
void Emit(std::string const &module, std::string const &event,
          Json const &value);
HWND WindowHandle(std::string const &id = {});
Json InvokeShell(std::string const &module, std::string const &method,
                 Array const &args);
Json EngineCall(std::string const &name, std::string const &profile,
                Object const &arguments);
Json InvokeServices(std::string const &module, std::string const &method,
                    Array const &args);
Json InvokeEngine(std::string const &method, Array const &args);
std::string Invoke(std::string const &module, std::string const &method,
                   std::string const &args);
int PrepareEngineProcess(void *sandboxInfo);
void ShutdownEngine();
inline Json Null() {
  return winrt::Windows::Data::Json::JsonValue::CreateNullValue();
}
inline Json String(std::string const &value) {
  return winrt::Windows::Data::Json::JsonValue::CreateStringValue(
      winrt::to_hstring(value));
}
inline Json Boolean(bool value) {
  return winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(value);
}
inline Json Number(double value) {
  return winrt::Windows::Data::Json::JsonValue::CreateNumberValue(value);
}
inline std::string Text(Json const &value) {
  return winrt::to_string(value.GetString());
}
inline std::string ArgText(Array const &args, unsigned index,
                           std::string fallback = {}) {
  return index < args.Size() &&
                 args.GetAt(index).ValueType() ==
                     winrt::Windows::Data::Json::JsonValueType::String
             ? Text(args.GetAt(index))
             : fallback;
}
} // namespace bay
