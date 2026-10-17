#include "../../../../packages/platform/windows/NativeContracts.g.h"
#include "WindowsHost.h"
#include "pch.h"
#include <stdexcept>

namespace bay::sync {
std::string Invoke(std::string const &, std::string const &,
                   std::string const &);
}
namespace bay::importer {
std::string Invoke(std::string const &, std::string const &,
                   std::string const &);
}
namespace bay {
std::string Invoke(std::string const &module, std::string const &method,
                   std::string const &arguments) {
  Object envelope;
  try {
    auto args = Array::Parse(winrt::to_hstring(arguments));
    const auto *contract = contracts::FindMethod(module, method);
    const bool viewCall =
        module == "BayCEF" &&
        (method == "mount" || method == "unmount" || method == "bounds" ||
         method == "updateProps" || method == "viewCall");
    if (!contract && !viewCall &&
        !(module == "BayShell" && method == "beginWindowDrag"))
      throw std::invalid_argument("Unknown native method: " + module + "." +
                                  method);
    if (contract && (args.Size() < contract->min_args ||
                     (contract->max_args >= 0 &&
                      args.Size() > static_cast<unsigned>(contract->max_args))))
      throw std::invalid_argument("Invalid argument count for " + module + "." +
                                  method);
    Json value = nullptr;
    if (module == "BayCEF") {
      try {
        value = InvokeServices(module, method, args);
      } catch (std::invalid_argument const &error) {
        if (std::string(error.what())
                .rfind("Unsupported Windows engine service:", 0) != 0)
          throw;
        value = InvokeEngine(method, args);
      }
    } else if (module == "BayChromeUI" || module == "BayExtensions")
      value = InvokeServices(module, method, args);
    else if (module == "BaySync")
      value = winrt::Windows::Data::Json::JsonValue::Parse(
          winrt::to_hstring(sync::Invoke(module, method, arguments)));
    else if (module == "BayImport")
      value = winrt::Windows::Data::Json::JsonValue::Parse(
          winrt::to_hstring(importer::Invoke(module, method, arguments)));
    else
      value = InvokeShell(module, method, args);
    envelope.SetNamedValue(L"value", value ? value : Null());
  } catch (winrt::hresult_error const &error) {
    Object detail;
    detail.SetNamedValue(L"code", String("E_WINDOWS"));
    detail.SetNamedValue(L"message", String(winrt::to_string(error.message())));
    envelope.SetNamedValue(L"error", detail);
  } catch (std::exception const &error) {
    Object detail;
    detail.SetNamedValue(L"code", String("E_NATIVE"));
    detail.SetNamedValue(L"message", String(error.what()));
    envelope.SetNamedValue(L"error", detail);
  }
  return winrt::to_string(envelope.Stringify());
}
} // namespace bay
