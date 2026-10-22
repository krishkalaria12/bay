// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_appearance.h"

#include <utility>

#include "base/json/json_writer.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "ui/native_theme/native_theme.h"

namespace bay {
namespace {
std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string InvalidArguments() {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue()
                     .Set("code", "invalid_args")
                     .Set("message", "Invalid native method arguments")))
      .value_or("{}");
}
}  // namespace

// static
base::ListValue ShellAppearance::SupportedMethods() {
  return base::ListValue()
      .Append("BayShell.setAppearance")
      .Append("BayShell.isDarkAppearance");
}

// static
bool ShellAppearance::Dispatch(const HostContext& context,
                               const std::string& module,
                               const std::string& method,
                               const base::ListValue& args,
                               Response& callback) {
  if (module != "BayShell" ||
      (method != "setAppearance" && method != "isDarkAppearance"))
    return false;
  if (method == "isDarkAppearance") {
    std::move(callback).Run(Success(base::Value(
        ui::NativeTheme::GetInstanceForNativeUi()->preferred_color_scheme() ==
        ui::NativeTheme::PreferredColorScheme::kDark)));
    return true;
  }
  const auto* mode = args.empty() ? nullptr : args[0].GetIfString();
  if (!mode || (*mode != "auto" && *mode != "light" && *mode != "dark")) {
    std::move(callback).Run(InvalidArguments());
    return true;
  }
  ThemeServiceFactory::GetForProfile(context.profile())
      ->SetBrowserColorScheme(
          *mode == "dark"    ? ThemeService::BrowserColorScheme::kDark
          : *mode == "light" ? ThemeService::BrowserColorScheme::kLight
                             : ThemeService::BrowserColorScheme::kSystem);
  std::move(callback).Run(Success());
  return true;
}
}  // namespace bay
