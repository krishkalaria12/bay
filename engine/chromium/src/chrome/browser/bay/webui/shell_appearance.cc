// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_appearance.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/common/pref_names.h"
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

ShellAppearance::ShellAppearance(HostContext context)
    : context_(std::move(context)) {}
ShellAppearance::~ShellAppearance() {
  SetEventSink({});
}

void ShellAppearance::SetEventSink(EventSink sink) {
  weak_factory_.InvalidateWeakPtrs();
  event_pending_ = false;
  last_dark_.reset();
  native_observation_.Reset();
  theme_observation_.Reset();
  scheme_pref_.Reset();
  profile_observations_.RemoveAllObservations();
  event_sink_ = std::move(sink);
  auto* profile = context_.profile();
  if (!event_sink_ || !profile || profile_destroyed_)
    return;
  // ThemeServiceFactory redirects OTR to its original profile. Observe both
  // lifetimes so neither a dying document profile nor a dying service can
  // retain an observation or queued event.
  profile_observations_.AddObservation(profile);
  auto* original = profile->GetOriginalProfile();
  if (original != profile)
    profile_observations_.AddObservation(original);
  theme_observation_.Observe(ThemeServiceFactory::GetForProfile(profile));
  // ThemeService suppresses theme notifications while an extension theme pack
  // is loading. Its selected scheme can still change during that interval.
  scheme_pref_.Init(original->GetPrefs());
  scheme_pref_.Add(prefs::kBrowserColorScheme,
                   base::BindRepeating(&ShellAppearance::ScheduleEvent,
                                       weak_factory_.GetWeakPtr()));
  native_observation_.Observe(ui::NativeTheme::GetInstanceForNativeUi());
  ScheduleEvent();
}

void ShellAppearance::OnProfileWillBeDestroyed(Profile* profile) {
  profile_destroyed_ = true;
  SetEventSink({});
}
void ShellAppearance::OnThemeChanged() {
  ScheduleEvent();
}
void ShellAppearance::OnNativeThemeUpdated(ui::NativeTheme* theme) {
  ScheduleEvent();
}
void ShellAppearance::ScheduleEvent() {
  if (event_pending_ || !event_sink_)
    return;
  event_pending_ = true;
  // ThemeService notifications are synchronous and forbid reentrant observer
  // iteration. Deliver after that stack returns and coalesce redundant changes.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&ShellAppearance::DeliverEvent,
                                weak_factory_.GetWeakPtr()));
}
void ShellAppearance::DeliverEvent() {
  event_pending_ = false;
  const bool dark = theme_observation_.GetSource()->BrowserUsesDarkColors();
  if (last_dark_ == dark)
    return;
  last_dark_ = dark;
  // The sink may replace itself, change appearance, or destroy this owner.
  auto sink = event_sink_;
  sink.Run(dark);
}

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
    std::move(callback).Run(Success(
        base::Value(ThemeServiceFactory::GetForProfile(context.profile())
                        ->BrowserUsesDarkColors())));
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
