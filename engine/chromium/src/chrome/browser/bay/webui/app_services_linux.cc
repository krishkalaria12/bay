// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/app_services_linux.h"

#include <utility>

#include "base/dcheck_is_on.h"
#include "base/environment.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/strings/cstring_view.h"
#include "base/strings/string_util.h"
#include "base/system/sys_info.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/platform_util.h"
#include "components/version_info/version_info.h"
#include "url/gurl.h"

namespace bay {
namespace {
std::string Success(base::Value value) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}
base::DictValue UpdaterState() {
  return base::DictValue()
      .Set("available", false)
      .Set("managedBy", "packageManager");
}
base::DictValue ReadSystemInfo(base::SysInfo::HardwareInfo hardware) {
  base::DictValue info;
  const auto version = base::SysInfo::OperatingSystemVersion();
  info.Set("osVersion", version);
  info.Set("osBuild", version);
  info.Set("arch", base::SysInfo::ProcessCPUArchitecture());
  info.Set("model", std::move(hardware.model));
  info.Set("memoryGB", base::SysInfo::AmountOfTotalPhysicalMemory().InGiBF());
  return info;
}
void CollectSystemInfo(AppServicesLinux::SystemInfoReply reply) {
  // Chromium's Linux hardware collector reads sysfs on a MayBlock worker and
  // replies on this sequence. No profile or service pointer enters either job.
  base::SysInfo::GetHardwareInfo(base::BindOnce(
      [](AppServicesLinux::SystemInfoReply reply,
         base::SysInfo::HardwareInfo hardware) {
        base::ThreadPool::PostTaskAndReplyWithResult(
            FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
            base::BindOnce(&ReadSystemInfo, std::move(hardware)),
            std::move(reply));
      },
      std::move(reply)));
}
base::DictValue EnvironmentSnapshot(
    const AppServicesLinux::Operations& operations) {
  base::DictValue environment;
#if DCHECK_IS_ON()
  auto native =
      operations.read_environment ? nullptr : base::Environment::Create();
  constexpr base::cstring_view keys[] = {
      "BAY_BACKGROUND", "BAY_CALENDAR_FIXTURE", "BAY_LIVE_MOCK",
      "BAY_ONBOARDING", "BAY_WHATS_NEW",        "BAY_TELEMETRY_DEV_SEND",
      "BAY_PERF_PROBE", "BAY_DATA_DIR"};
  for (const auto key : keys) {
    auto value = operations.read_environment
                     ? operations.read_environment.Run(key.c_str())
                     : native->GetVar(key);
    if (value && base::IsStringUTF8(*value))
      environment.Set(key, std::move(*value));
  }
#endif
  return environment;
}
}  // namespace

AppServicesLinux::AppServicesLinux(HostContext context, std::string locale)
    : AppServicesLinux(std::move(context), std::move(locale), {}) {}
AppServicesLinux::AppServicesLinux(HostContext context,
                                   std::string locale,
                                   Operations operations)
    : context_(std::move(context)),
      locale_(std::move(locale)),
      operations_(std::move(operations)) {
  if (!operations_.collect_system_info)
    operations_.collect_system_info = base::BindRepeating(&CollectSystemInfo);
  if (!operations_.open_external_url)
    operations_.open_external_url =
        base::BindRepeating(&platform_util::OpenExternal);
}
AppServicesLinux::~AppServicesLinux() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
}

// static
base::ListValue AppServicesLinux::SupportedMethods() {
  return base::ListValue()
      .Append("BayApp.systemInfo")
      .Append("BayApp.launchEnvironment")
      .Append("BayApp.openExternalURL")
      .Append("BayApp.updaterState");
}
void AppServicesLinux::Prepare(base::OnceClosure ready) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (ready_) {
    std::move(ready).Run();
    return;
  }
  ready_callbacks_.push_back(std::move(ready));
  if (preparing_)
    return;
  preparing_ = true;
  environment_ = EnvironmentSnapshot(operations_);
  // A synchronous fake reply may run readiness closures that delete us.
  auto collect = operations_.collect_system_info;
  collect.Run(
      base::BindOnce(&AppServicesLinux::Prepared, weak_factory_.GetWeakPtr()));
}
void AppServicesLinux::Prepared(base::DictValue system_info) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  system_info.Set("appName", "Bay");
  system_info.Set("appVersion", version_info::GetVersionNumber());
  system_info.Set("appBuild", version_info::GetLastChange());
  system_info.Set("bundleId", "Bay.Browser");
#if DCHECK_IS_ON()
  system_info.Set("configuration", "Debug");
#else
  system_info.Set("configuration", "Release");
#endif
  system_info.Set("locale", locale_);
  system_info.Set("updates", false);
  snapshots_.Set("systemInfo", std::move(system_info));
  snapshots_.Set("environment", std::move(environment_));
  snapshots_.Set("updaterState", UpdaterState());
  ready_ = true;
  preparing_ = false;
  // Callbacks may reenter Prepare/Dispatch or destroy this document. Remaining
  // callbacks still run once, with no subsequent member access.
  auto callbacks = std::move(ready_callbacks_);
  for (auto& callback : callbacks)
    std::move(callback).Run();
}
bool AppServicesLinux::ready() const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return ready_;
}
base::DictValue AppServicesLinux::snapshots() const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return snapshots_.Clone();
}
bool AppServicesLinux::Dispatch(const std::string& module,
                                const std::string& method,
                                const base::ListValue& args,
                                Response& callback) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (module != "BayApp" ||
      (method != "systemInfo" && method != "launchEnvironment" &&
       method != "openExternalURL" && method != "updaterState"))
    return false;
  if (!context_.profile()) {
    std::move(callback).Run(Failure("profile_unavailable",
                                    "The host profile is no longer available"));
    return true;
  }
  if (!ready_) {
    std::move(callback).Run(
        Failure("initialization_failed", "Bay native services are not ready"));
    return true;
  }
  const bool takes_text =
      method == "launchEnvironment" || method == "openExternalURL";
  const auto* text = args.size() == 1 ? args[0].GetIfString() : nullptr;
  if ((takes_text && (!text || !base::IsStringUTF8(*text) ||
                      text->find('\0') != std::string::npos)) ||
      (!takes_text && !args.empty())) {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid native method arguments"));
    return true;
  }
  if (method == "systemInfo" || method == "updaterState") {
    std::move(callback).Run(Success(snapshots_.Find(method)->Clone()));
    return true;
  }
  if (method == "launchEnvironment") {
    // This never queries the live environment, even for unknown names.
    const auto* value = snapshots_.FindDict("environment")->Find(*text);
    std::move(callback).Run(Success(value ? value->Clone() : base::Value()));
    return true;
  }
  GURL url(*text);
  if (!url.is_valid() ||
      !(url.SchemeIsHTTPOrHTTPS() || url.SchemeIs("mailto"))) {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid native method arguments"));
    return true;
  }
  // Native OpenExternal uses Linux PortalHelper's OpenURI and fallback. The
  // void API cannot report desktop acceptance. Copy both callbacks before the
  // opener, since an injected opener can reenter or destroy this owner.
  auto open = operations_.open_external_url;
  auto response = std::move(callback);
  open.Run(url);
  std::move(response).Run(Success(base::Value(true)));
  return true;
}
}  // namespace bay
