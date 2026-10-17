#include "WindowsHost.h"
#include "pch.h"
#include <cmath>
#include <map>
#include <stdexcept>
#include <vector>

namespace bay {
namespace {
struct Service {
  char const *name;
  unsigned profile;
  std::vector<char const *> keys;
  char const *result = nullptr;
};
Object Arguments(Array const &args, unsigned offset,
                 std::vector<char const *> keys) {
  Object value;
  for (auto key : keys) {
    if (offset < args.Size() &&
        args.GetAt(offset).ValueType() !=
            winrt::Windows::Data::Json::JsonValueType::Null)
      value.SetNamedValue(winrt::to_hstring(key), args.GetAt(offset));
    ++offset;
  }
  return value;
}
} // namespace
Json InvokeServices(std::string const &module, std::string const &method,
                    Array const &args) {
  if (module == "BayCEF") {
    static std::map<std::string, Service> const methods = {
        {"listPasswords", {"nn_passwords_list", 0, {}}},
        {"unlockPasswords", {"nn_passwords_unlock", 0, {}}},
        {"getPassword", {"nn_passwords_reveal", 0, {"origin", "username"}}},
        {"savePassword",
         {"nn_passwords_add", 0, {"origin", "username", "password"}}},
        {"updatePassword",
         {"nn_passwords_update",
          0,
          {"origin", "username", "newUsername", "newPassword"}}},
        {"deletePassword", {"nn_passwords_remove", 0, {"origin", "username"}}},
        {"getNeverSavePasswordOrigins", {"nn_passwords_exceptions", 0, {}}},
        {"allowSavingPasswords", {"nn_passwords_allow", 0, {"origin"}}},
        {"listAddresses", {"nn_autofill_addresses", 0, {}}},
        {"saveAddress", {"nn_autofill_save_address", 0, {"address"}}},
        {"listCards", {"nn_autofill_cards", 0, {}}},
        {"saveCard", {"nn_autofill_save_card", 0, {"card", "number"}}},
        {"deleteAutofillEntry", {"nn_autofill_remove", 0, {"id"}}},
        {"revealCardNumber", {"nn_autofill_card_number", 0, {"id"}}},
        {"setZoom", {"nn_zoom_set", 0, {"host", "level"}}},
        {"getZoomLevels", {"nn_zoom_list", 0, {}, "levels"}},
        {"getSiteSettings",
         {"nn_site_settings_get", 0, {"origin"}, "settings"}},
        {"getSiteSettingsOrigins",
         {"nn_site_settings_origins", 0, {}, "origins"}},
        {"setSiteSetting",
         {"nn_site_settings_set", 0, {"origin", "type", "value"}}},
        {"resetSiteSettings", {"nn_site_settings_reset", 0, {"origin"}}},
        {"clearSiteData", {"nn_site_data_clear", 0, {"origin"}}},
        {"getExternalAppAllowances",
         {"nn_external_apps_allowances", 0, {}, "allowances"}},
        {"removeExternalAppAllowance",
         {"nn_external_apps_remove", 0, {"origin", "scheme"}}}};
    auto found = methods.find(method);
    if (found != methods.end()) {
      auto const &service = found->second;
      auto result =
          EngineCall(service.name, ArgText(args, service.profile),
                     Arguments(args, service.profile + 1, service.keys));
      return service.result ? result.GetObject().GetNamedValue(
                                  winrt::to_hstring(service.result))
                            : result;
    }
    if (method == "components")
      return EngineCall("nn_components_list", "", Object())
          .GetObject()
          .GetNamedValue(L"components");
    if (method == "listTasks")
      return EngineCall("nn_tasks_list", "", Object())
          .GetObject()
          .GetNamedValue(L"tasks");
    if (method == "killTask")
      return EngineCall("nn_tasks_kill", "", Arguments(args, 0, {"id"}))
          .GetObject()
          .GetNamedValue(L"ok");
    if (method == "getPasswordAutofill" || method == "getAutofillSettings") {
      auto get = [&](char const *name) {
        Object request;
        request.SetNamedValue(L"name", String(name));
        return EngineCall("nn_prefs_get", ArgText(args, 0), request)
            .GetObject()
            .GetNamedValue(L"value");
      };
      if (method == "getPasswordAutofill")
        return get("credentials_enable_service");
      Object settings;
      settings.SetNamedValue(L"addresses", get("autofill.profile_enabled"));
      settings.SetNamedValue(L"cards", get("autofill.credit_card_enabled"));
      return settings;
    }
    if (method == "setPasswordAutofill" || method == "setAutofillSettings") {
      auto set = [&](char const *name, Json const &value) {
        if (value.ValueType() ==
            winrt::Windows::Data::Json::JsonValueType::Null)
          return;
        Object request;
        request.SetNamedValue(L"name", String(name));
        request.SetNamedValue(L"value", value);
        EngineCall("nn_prefs_set", ArgText(args, 0), request);
      };
      if (method == "setPasswordAutofill")
        set("credentials_enable_service", args.GetAt(1));
      else {
        set("autofill.profile_enabled", args.GetAt(1));
        set("autofill.credit_card_enabled", args.GetAt(2));
      }
      return Null();
    }
  }
  if (module == "BayExtensions") {
    if (method == "list")
      return EngineCall("nn_extensions_list", ArgText(args, 0), Object());
    if (method == "searchEngineList")
      return EngineCall("nn_search_engines_list", ArgText(args, 0), Object());
    if (method == "install") {
      auto request = Arguments(args, 0, {"path"});
      return EngineCall("nn_extensions_install", ArgText(args, 1), request);
    }
    if (method == "setEnabled" || method == "uninstall" || method == "reload" ||
        method == "configure") {
      auto request = Arguments(args, 0, {"id"});
      if (method == "setEnabled")
        request.SetNamedValue(L"enabled", args.GetAt(2));
      if (method == "configure")
        for (auto const &entry : args.GetObjectAt(2))
          request.SetNamedValue(entry.Key(), entry.Value());
      return EngineCall(method == "setEnabled"  ? "nn_extensions_set_enabled"
                        : method == "uninstall" ? "nn_extensions_uninstall"
                        : method == "reload"    ? "nn_extensions_reload"
                                                : "nn_extensions_configure",
                        ArgText(args, 1), request);
    }
  }
  throw std::invalid_argument("Unsupported Windows engine service: " + module +
                              "." + method);
}
} // namespace bay
