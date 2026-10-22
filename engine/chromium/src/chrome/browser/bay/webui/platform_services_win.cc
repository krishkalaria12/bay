// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/platform_services_win.h"
#include "chrome/browser/bay/webui/document_store.h"
#include "chrome/browser/bay/webui/notifications.h"
#include "chrome/browser/bay/webui/shell_ui.h"

#include <windows.h>

#include <shellapi.h>
#include <wincred.h>

#include <map>
#include <optional>
#include <string_view>
#include <utility>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/notreached.h"
#include "base/path_service.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/win/registry.h"
#include "base/win/windows_version.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/platform_util.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/shell_integration.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/common/chrome_paths.h"
#include "components/version_info/version_info.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/base_window.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/gfx/codec/jpeg_codec.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/native_theme/native_theme.h"
#include "url/gurl.h"

namespace bay {
namespace {
using Response = PlatformServices::Response;
constexpr wchar_t kRunKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kLoginName[] = L"Bay";

std::string JSON(const base::DictValue& value) {
  return base::WriteJson(value).value_or("{}");
}
std::string Success(base::Value value = base::Value()) {
  return JSON(base::DictValue().Set("value", std::move(value)));
}
std::string Failure(std::string_view code, std::string_view message) {
  return JSON(base::DictValue().Set(
      "error", base::DictValue().Set("code", code).Set("message", message)));
}
const base::Value* At(const base::ListValue& args, size_t index) {
  return index < args.size() ? &args[index] : nullptr;
}
const std::string* Text(const base::ListValue& args, size_t index) {
  const auto* value = At(args, index);
  return value && value->is_string() ? &value->GetString() : nullptr;
}
const base::DictValue* Object(const base::ListValue& args, size_t index) {
  const auto* value = At(args, index);
  return value && value->is_dict() ? &value->GetDict() : nullptr;
}
std::map<PlatformServices*, base::WeakPtr<PlatformServices>>& Services() {
  static base::NoDestructor<
      std::map<PlatformServices*, base::WeakPtr<PlatformServices>>>
      services;
  return *services;
}
scoped_refptr<base::SequencedTaskRunner> DiskRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}
scoped_refptr<base::SingleThreadTaskRunner> ShellRunner() {
  static base::NoDestructor<scoped_refptr<base::SingleThreadTaskRunner>> runner(
      base::ThreadPool::CreateCOMSTATaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}

base::DictValue SystemInfo(const std::string& locale) {
  base::DictValue info;
  info.Set("appName", "Bay");
  info.Set("appVersion", version_info::GetVersionNumber());
  info.Set("appBuild", version_info::GetLastChange());
  info.Set("bundleId", "Bay");
#if DCHECK_IS_ON()
  info.Set("configuration", "Debug");
#else
  info.Set("configuration", "Release");
#endif
  info.Set("osVersion", base::SysInfo::OperatingSystemVersion());
  info.Set("osBuild", base::SysInfo::OperatingSystemVersion());
  info.Set("arch", base::SysInfo::ProcessCPUArchitecture());
  info.Set("model", base::SysInfo::HardwareModelName());
  info.Set("memoryGB", base::SysInfo::AmountOfTotalPhysicalMemory().InGiBF());
  info.Set("locale", locale);
  info.Set("updates", false);
  return info;
}
base::DictValue EnvironmentSnapshot() {
  base::DictValue values;
#if DCHECK_IS_ON()
  auto environment = base::Environment::Create();
  for (const char* key :
       {"BAY_BACKGROUND", "BAY_CALENDAR_FIXTURE", "BAY_LIVE_MOCK",
        "BAY_ONBOARDING", "BAY_WHATS_NEW", "BAY_TELEMETRY_DEV_SEND",
        "BAY_PERF_PROBE", "BAY_DATA_DIR"}) {
    if (auto value = environment->GetVar(key))
      values.Set(key, *value);
  }
#endif
  return values;
}
base::DictValue ReadInitialData(std::string locale,
                                base::DictValue environment) {
  base::DictValue snapshots;
  snapshots.Set("BayApp", base::DictValue()
                              .Set("systemInfo", SystemInfo(locale))
                              .Set("environment", std::move(environment)));
  base::FilePath downloads;
  base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &downloads);
  snapshots.Set("BaySystem",
                base::DictValue().Set(
                    "downloadsFolder",
                    downloads.empty() ? base::Value()
                                      : base::Value(downloads.AsUTF8Unsafe())));
  return snapshots;
}

std::string Credential(const std::string& method,
                       const std::string& account,
                       std::string secret) {
  base::ScopedClosureRunner wipe(base::BindOnce(
      [](std::string* value) {
        SecureZeroMemory(value->data(), value->size());
      },
      &secret));
  if (account.empty() || !base::IsStringUTF8(account) ||
      account.find('\0') != std::string::npos)
    return Failure("invalid_args", "Credential account is invalid");
  const std::wstring target = L"Bay:" + base::UTF8ToWide(account);
  if (target.size() > CRED_MAX_GENERIC_TARGET_NAME_LENGTH)
    return Failure("invalid_args", "Credential account is too long");
  if (method == "get") {
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &credential)) {
      return GetLastError() == ERROR_NOT_FOUND
                 ? Success()
                 : Failure("credential_error",
                           "Windows could not read this credential");
    }
    std::string value(reinterpret_cast<char*>(credential->CredentialBlob),
                      credential->CredentialBlobSize);
    SecureZeroMemory(credential->CredentialBlob,
                     credential->CredentialBlobSize);
    CredFree(credential);
    if (!base::IsStringUTF8(value)) {
      SecureZeroMemory(value.data(), value.size());
      return Failure("credential_error", "The saved credential is invalid");
    }
    return Success(base::Value(std::move(value)));
  }
  if (method == "delete") {
    const bool deleted = CredDeleteW(target.c_str(), CRED_TYPE_GENERIC, 0);
    return Success(base::Value(deleted || GetLastError() == ERROR_NOT_FOUND));
  }
  if (secret.size() > CRED_MAX_CREDENTIAL_BLOB_SIZE)
    return Failure("invalid_args", "Credential exceeds the Windows size limit");
  CREDENTIALW credential{};
  credential.Type = CRED_TYPE_GENERIC;
  credential.TargetName = const_cast<wchar_t*>(target.c_str());
  credential.CredentialBlobSize = static_cast<DWORD>(secret.size());
  credential.CredentialBlob =
      reinterpret_cast<BYTE*>(const_cast<char*>(secret.data()));
  credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
  const bool saved = CredWriteW(&credential, 0) != FALSE;
  return Success(base::Value(saved));
}
std::string LoginSetting(std::optional<bool> enabled) {
  base::win::RegKey key;
  const LONG opened = enabled && *enabled
                          ? key.Create(HKEY_CURRENT_USER, kRunKey,
                                       KEY_QUERY_VALUE | KEY_SET_VALUE)
                          : key.Open(HKEY_CURRENT_USER, kRunKey,
                                     KEY_QUERY_VALUE | KEY_SET_VALUE);
  if (opened == ERROR_FILE_NOT_FOUND)
    return enabled ? Success() : Success(base::Value("notRegistered"));
  if (opened != ERROR_SUCCESS)
    return Failure("registry_error",
                   "Windows startup settings are unavailable");
  if (!enabled) {
    std::wstring command;
    const bool present = key.ReadValue(kLoginName, &command) == ERROR_SUCCESS;
    if (!present)
      return Success(base::Value("notRegistered"));
    return Success(base::Value("enabled"));
  }
  if (*enabled) {
    base::FilePath executable;
    if (!base::PathService::Get(base::FILE_EXE, &executable))
      return Failure("path_error", "Bay executable path is unavailable");
    const auto command =
        L"\"" + executable.value() + L"\" --bay-launch-at-login";
    if (key.WriteValue(kLoginName, command.c_str()) != ERROR_SUCCESS)
      return Failure("registry_error",
                     "Windows could not save startup settings");
  } else {
    auto result = key.DeleteValue(kLoginName);
    if (result != ERROR_SUCCESS && result != ERROR_FILE_NOT_FOUND)
      return Failure("registry_error",
                     "Windows could not remove startup settings");
  }
  return Success();
}
}  // namespace

PlatformServices::PlatformServices(HostContext context,
                                   base::RepeatingClosure changed)
    : context_(std::move(context)),
      snapshots_changed_(std::move(changed)),
      disk_runner_(DiskRunner()),
      documents_(DocumentStore::DefaultDirectory(), snapshots_changed_) {
  Services()[this] = weak_factory_.GetWeakPtr();
}
PlatformServices::~PlatformServices() {
  Services().erase(this);
}
void PlatformServices::Prepare(base::OnceClosure ready) {
  if (ready_) {
    std::move(ready).Run();
    return;
  }
  ready_callbacks_.push_back(std::move(ready));
  if (preparing_)
    return;
  preparing_ = true;
  disk_runner_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&ReadInitialData,
                     g_browser_process->GetApplicationLocale(),
                     EnvironmentSnapshot()),
      base::BindOnce(&PlatformServices::Prepared, weak_factory_.GetWeakPtr()));
}
void PlatformServices::Prepared(base::DictValue snapshots) {
  snapshots_ = std::move(snapshots);
  documents_.Prepare(base::BindOnce(&PlatformServices::DocumentsReady,
                                    weak_factory_.GetWeakPtr()));
}
void PlatformServices::DocumentsReady() {
  initialization_error_ = documents_.error();
  ready_ = true;
  preparing_ = false;
  auto callbacks = std::move(ready_callbacks_);
  for (auto& callback : callbacks)
    std::move(callback).Run();
}
base::DictValue PlatformServices::Snapshots() const {
  auto snapshots = snapshots_.Clone();
  snapshots.Set("BayShell",
                base::DictValue().Set("documents", documents_.documents()));
  return snapshots;
}
base::ListValue PlatformServices::Modules() const {
  return base::ListValue()
      .Append("BayApp")
      .Append("BayShell")
      .Append("BaySystem")
      .Append("BayKeychain")
      // Capability marker: notification methods live on BayApp's contract.
      .Append("BayNotifications");
}
base::ListValue PlatformServices::SupportedMethods() const {
  base::ListValue methods;
  for (auto* name : {"BayShell.showMenu",
                     "BayShell.copyText",
                     "BayShell.copyImage",
                     "BayShell.pickFiles",
                     "BayShell.confirm",
                     "BayShell.prompt",
                     "BayShell.setAppearance",
                     "BayShell.isDarkAppearance",
                     "BaySystem.isDefaultBrowser",
                     "BaySystem.setAsDefaultBrowser",
                     "BaySystem.fileExists",
                     "BaySystem.fileIcon",
                     "BaySystem.downloadsFolder",
                     "BaySystem.openFile",
                     "BaySystem.revealFile",
                     "BaySystem.moveToTrash",
                     "BaySystem.launchAtLoginStatus",
                     "BaySystem.setLaunchAtLogin",
                     "BayApp.systemInfo",
                     "BayApp.launchEnvironment",
                     "BayApp.openExternalURL",
                     "BayApp.updaterState",
                     "BayKeychain.get",
                     "BayKeychain.set",
                     "BayKeychain.delete"})
    methods.Append(name);
  for (auto& method : Notifications::SupportedMethods())
    methods.Append(std::move(method));
  for (auto& method : DocumentStore::SupportedMethods())
    methods.Append(std::move(method));
  return methods;
}
bool PlatformServices::DispatchPlatformModule(const std::string& module,
                                              const std::string& method,
                                              const base::ListValue& args,
                                              Response& callback) {
  const std::string qualified = module + "." + method;
  bool supported = false;
  for (const auto& name : SupportedMethods())
    if (name.GetString() == qualified)
      supported = true;
  if (!supported)
    return false;
  if (!context_.profile()) {
    std::move(callback).Run(Failure("profile_unavailable",
                                    "The host profile is no longer available"));
    return true;
  }
  if (module == "BayShell" && (method == "showMenu" || method == "pickFiles") &&
      !context_.window()) {
    std::move(callback).Run(
        Failure("window_required", "This operation requires a window host"));
    return true;
  }
  if (!ready_ || !initialization_error_.empty()) {
    std::move(callback).Run(Failure("initialization_failed",
                                    initialization_error_.empty()
                                        ? "Bay native services are not ready"
                                        : initialization_error_));
    return true;
  }
  if (!shell_ui_)
    shell_ui_ = std::make_unique<ShellUI>();
  if (shell_ui_->Dispatch(context_, module, method, args, callback))
    return true;
  if (module == "BayApp" &&
      Notifications::Get().Dispatch(context_, method, args, callback))
    return true;
  auto invalid = [&] {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid native method arguments"));
  };
  if (module == "BayKeychain") {
    const auto* account = Text(args, 0);
    const auto* secret = Text(args, 1);
    if (!account || (method == "set" && !secret)) {
      invalid();
      return true;
    }
    disk_runner_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&Credential, method, *account, secret ? *secret : ""),
        std::move(callback));
    return true;
  }
  if (documents_.Dispatch(module, method, args, callback))
    return true;
  if (module == "BayShell" && method == "copyText") {
    const auto* text = Text(args, 0);
    if (!text) {
      invalid();
      return true;
    }
    {
      ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
      writer.WriteText(base::UTF8ToUTF16(*text));
    }
    std::move(callback).Run(Success());
    return true;
  }
  if (module == "BayShell" && method == "copyImage") {
    const auto* encoded = Text(args, 0);
    std::string bytes;
    if (!encoded || !base::Base64Decode(*encoded, &bytes)) {
      invalid();
      return true;
    }
    auto bitmap = gfx::PNGCodec::Decode(base::as_byte_span(bytes));
    if (bitmap.isNull())
      bitmap = gfx::JPEGCodec::Decode(base::as_byte_span(bytes));
    if (!bitmap.isNull()) {
      ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
      writer.WriteImage(bitmap);
    }
    std::move(callback).Run(Success(base::Value(!bitmap.isNull())));
    return true;
  }
  if (module == "BayShell" && method == "isDarkAppearance") {
    std::move(callback).Run(Success(base::Value(
        ui::NativeTheme::GetInstanceForNativeUi()->preferred_color_scheme() ==
        ui::NativeTheme::PreferredColorScheme::kDark)));
    return true;
  }
  if (module == "BayShell" && method == "setAppearance") {
    const auto* mode = Text(args, 0);
    if (!mode || (*mode != "auto" && *mode != "light" && *mode != "dark")) {
      invalid();
      return true;
    }
    ThemeServiceFactory::GetForProfile(context_.profile())
        ->SetBrowserColorScheme(
            *mode == "dark"    ? ThemeService::BrowserColorScheme::kDark
            : *mode == "light" ? ThemeService::BrowserColorScheme::kLight
                               : ThemeService::BrowserColorScheme::kSystem);
    std::move(callback).Run(Success());
    return true;
  }
  if (module == "BaySystem" &&
      (method == "isDefaultBrowser" || method == "setAsDefaultBrowser")) {
    auto worker =
        base::MakeRefCounted<shell_integration::DefaultBrowserWorker>();
    auto done = base::BindOnce(
        [](Response callback, shell_integration::DefaultWebClientState state) {
          std::move(callback).Run(
              Success(base::Value(state == shell_integration::IS_DEFAULT)));
        },
        std::move(callback));
    if (method == "isDefaultBrowser")
      worker->StartCheckIsDefault(std::move(done));
    else
      worker->StartSetAsDefault(std::move(done));
    return true;
  }
  if (module == "BaySystem" &&
      (method == "launchAtLoginStatus" || method == "setLaunchAtLogin")) {
    const auto* enabled = At(args, 0);
    if (method == "setLaunchAtLogin" && (!enabled || !enabled->is_bool())) {
      invalid();
      return true;
    }
    disk_runner_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&LoginSetting,
                       method == "setLaunchAtLogin"
                           ? std::make_optional(enabled->GetBool())
                           : std::nullopt),
        std::move(callback));
    return true;
  }
  if (module == "BaySystem" && method == "downloadsFolder") {
    const auto* value =
        snapshots_.FindByDottedPath("BaySystem.downloadsFolder");
    std::move(callback).Run(Success(value ? value->Clone() : base::Value()));
    return true;
  }
  if (module == "BaySystem" &&
      (method == "fileExists" || method == "openFile" ||
       method == "revealFile" || method == "moveToTrash")) {
    const auto* name = Text(args, 0);
    if (!name || !base::IsStringUTF8(*name) ||
        name->find_first_of(std::string("\0*?", 3)) != std::string::npos) {
      invalid();
      return true;
    }
    auto path = base::FilePath::FromUTF8Unsafe(*name);
    if (!path.IsAbsolute()) {
      invalid();
      return true;
    }
    if (method == "fileExists") {
      disk_runner_->PostTaskAndReplyWithResult(
          FROM_HERE, base::BindOnce(&base::PathExists, path),
          base::BindOnce(
              [](Response callback, bool exists) {
                std::move(callback).Run(Success(base::Value(exists)));
              },
              std::move(callback)));
    } else if (method == "openFile") {
      platform_util::OpenItem(
          context_.profile(), path, platform_util::OPEN_FILE,
          base::BindOnce(
              [](Response callback, platform_util::OpenOperationResult result) {
                std::move(callback).Run(Success(
                    base::Value(result == platform_util::OPEN_SUCCEEDED)));
              },
              std::move(callback)));
    } else if (method == "revealFile") {
      platform_util::ShowItemInFolder(context_.profile(), path);
      std::move(callback).Run(Success(base::Value(true)));
    } else {
      ShellRunner()->PostTaskAndReplyWithResult(
          FROM_HERE,
          base::BindOnce(
              [](base::FilePath path) {
                std::wstring source = path.value();
                source.push_back(L'\0');
                source.push_back(L'\0');
                SHFILEOPSTRUCTW operation{};
                operation.wFunc = FO_DELETE;
                operation.pFrom = source.c_str();
                operation.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION |
                                   FOF_NOERRORUI | FOF_SILENT;
                return SHFileOperationW(&operation) == 0 &&
                       !operation.fAnyOperationsAborted;
              },
              path),
          base::BindOnce(
              [](Response callback, bool result) {
                std::move(callback).Run(Success(base::Value(result)));
              },
              std::move(callback)));
    }
    return true;
  }
  if (module == "BayApp" && method == "systemInfo") {
    std::move(callback).Run(
        Success(snapshots_.FindByDottedPath("BayApp.systemInfo")->Clone()));
    return true;
  }
  if (module == "BayApp" && method == "launchEnvironment") {
    const auto* name = Text(args, 0);
    if (!name) {
      invalid();
      return true;
    }
    const auto* values = snapshots_.FindDictByDottedPath("BayApp.environment");
    const auto* value = values->Find(*name);
    std::move(callback).Run(Success(value ? value->Clone() : base::Value()));
    return true;
  }
  if (module == "BayApp" && method == "updaterState") {
    std::move(callback).Run(
        Success(base::Value(base::DictValue().Set("available", false))));
    return true;
  }
  if (module == "BayApp" && method == "openExternalURL") {
    const auto* text = Text(args, 0);
    if (!text) {
      invalid();
      return true;
    }
    GURL url(*text);
    if (!url.is_valid() ||
        !(url.SchemeIsHTTPOrHTTPS() || url.SchemeIs("mailto"))) {
      invalid();
      return true;
    }
    platform_util::OpenExternal(url);
    std::move(callback).Run(Success(base::Value(true)));
    return true;
  }
  NOTREACHED();
  return true;
}
}  // namespace bay
