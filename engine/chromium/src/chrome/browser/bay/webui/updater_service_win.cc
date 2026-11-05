// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/updater_service_win.h"

#include <windows.h>

#include <softpub.h>
#include <wintrust.h>

#include <algorithm>
#include <string_view>
#include <utility>

#include "base/base_paths.h"
#include "base/base_paths_win.h"
#include "base/command_line.h"
#include "base/environment.h"
#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/uuid.h"
#include "base/version.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/views/message_box_dialog.h"
#include "crypto/sha2.h"
#include "ui/base/base_window.h"
#include "url/gurl.h"

namespace bay {
namespace {
constexpr size_t kMaximumJsonBytes = 1024 * 1024;
constexpr auto kCheckInterval = base::Hours(24);

std::string Success(base::Value value = base::Value()) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or(
          "{\"error\":{\"code\":\"updater_failed\",\"message\":\"Could not "
          "encode updater response\"}}");
}

std::string Failure(std::string_view error) {
  return base::WriteJson(
             base::DictValue().Set("error", base::DictValue()
                                                .Set("code", "updater_failed")
                                                .Set("message", error)))
      .value_or(
          "{\"error\":{\"code\":\"updater_failed\",\"message\":\"Updater "
          "failed\"}}");
}

bool TrustedSignature(const base::FilePath& executable) {
  WINTRUST_FILE_INFO file = {};
  file.cbStruct = sizeof(file);
  file.pcwszFilePath = executable.value().c_str();
  WINTRUST_DATA trust = {};
  trust.cbStruct = sizeof(trust);
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  trust.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG result = WinVerifyTrust(nullptr, &action, &trust);
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &action, &trust);
  return result == ERROR_SUCCESS;
}

std::optional<base::DictValue> EmbeddedPolicy() {
  HMODULE module = GetModuleHandleW(nullptr);
  HRSRC resource = FindResourceW(module, MAKEINTRESOURCEW(201), RT_RCDATA);
  if (!resource) {
    return std::nullopt;
  }
  const DWORD size = SizeofResource(module, resource);
  const void* bytes = LockResource(LoadResource(module, resource));
  if (!bytes || size == 0 || size > kMaximumJsonBytes) {
    return std::nullopt;
  }
  return base::JSONReader::ReadDict(
      std::string_view(static_cast<const char*>(bytes), size),
      base::JSON_PARSE_RFC);
}

bool ValidPolicy(const base::DictValue& policy) {
  const std::string* version = policy.FindString("version");
  const std::string* app_version = policy.FindString("appVersion");
  const std::string* channel = policy.FindString("channel");
  const std::string* feed = policy.FindString("feedUrl");
  const base::ListValue* origins = policy.FindList("allowedOrigins");
  const base::ListValue* publishers = policy.FindList("publisherThumbprints");
  const auto* script_hash = policy.FindString("scriptSha256");
  if (!policy.FindBool("enabled").value_or(false) || !version || !app_version ||
      *app_version != *version || !channel ||
      (*channel != "stable" && *channel != "beta") || !feed || !origins ||
      !publishers || publishers->empty() || !script_hash ||
      script_hash->size() != 64 ||
      script_hash->find_first_not_of("0123456789abcdefABCDEF") !=
          std::string::npos) {
    return false;
  }
  const base::Version parsed(*version);
  const GURL url(*feed);
  if (!parsed.IsValid() || parsed.components().size() < 3 ||
      parsed.components().size() > 4 || !url.is_valid() ||
      !url.SchemeIs("https") || url.has_username() || url.has_password()) {
    return false;
  }
  const std::string origin =
      base::ToLowerASCII(url.DeprecatedGetOriginAsURL().spec());
  return std::ranges::any_of(*origins, [&origin](const base::Value& value) {
    return value.is_string() && origin == value.GetString() + "/";
  });
}

bool WritePreferences(const base::FilePath& path,
                      bool checks,
                      bool downloads,
                      std::optional<double> last_check) {
  if (path.empty() || !base::CreateDirectory(path.DirName())) {
    return false;
  }
  base::DictValue values;
  values.Set("automaticChecks", checks);
  values.Set("automaticDownloads", downloads);
  values.Set("lastCheck",
             last_check ? base::Value(*last_check) : base::Value());
  auto json = base::WriteJson(values);
  return json && base::ImportantFileWriter::WriteFileAtomically(path, *json);
}
}  // namespace

struct UpdaterCommandResult {
  base::DictValue value;
  base::FilePath cancel_path;
  std::string error;
};

struct UpdaterInitialization {
  base::FilePath executable;
  base::FilePath powershell;
  base::FilePath script;
  base::FilePath settings;
  base::DictValue policy;
  bool configured = false;
  bool checks = true;
  bool downloads = false;
  bool staged = false;
  std::string pending_version;
  std::optional<double> last_check;
  std::string error;
};

namespace {
base::FilePath ValidatedCancelPath(const base::DictValue& response,
                                   const base::DictValue& policy) {
  const auto* supplied = response.FindString("cancelPath");
  const auto* version = response.FindString("version");
  const auto* channel = policy.FindString("channel");
  base::FilePath local;
  if (!supplied || !version || !channel ||
      !base::PathService::Get(base::DIR_LOCAL_APP_DATA, &local)) {
    return {};
  }
  const auto path = base::FilePath::FromUTF8Unsafe(*supplied);
  if (!path.IsAbsolute() || path.ReferencesParent() ||
      path.BaseName() !=
          base::FilePath(FILE_PATH_LITERAL("state.json.cancel"))) {
    return {};
  }
  base::FilePath worker;
  base::FilePath cache;
  const auto expected = local.AppendASCII("Bay")
                            .AppendASCII("Updates")
                            .AppendASCII(*channel)
                            .AppendASCII(*version);
  if (!base::NormalizeFilePath(path.DirName(), &worker) ||
      !base::NormalizeFilePath(expected, &cache) || worker.DirName() != cache) {
    return {};
  }
  const auto name = worker.BaseName().AsUTF8Unsafe();
  if (!name.starts_with("apply-") ||
      !base::Uuid::ParseCaseInsensitive(name.substr(6)).is_valid() ||
      !base::PathExists(worker.AppendASCII("state.json"))) {
    return {};
  }
  return worker.AppendASCII("state.json.cancel");
}
bool WriteCancellation(const base::FilePath& path) {
  return !path.empty() &&
         base::ImportantFileWriter::WriteFileAtomically(path, "cancelled\n");
}
UpdaterCommandResult RunUpdater(const base::FilePath& executable,
                                const base::FilePath& powershell,
                                const base::FilePath& script,
                                const base::DictValue& policy,
                                const std::string& mode,
                                bool deferred,
                                bool use_staged) {
  UpdaterCommandResult result;
  // Revalidate before each operation, including installation after a prompt.
  // PowerShell independently enforces the embedded policy and publisher pins.
  if (!TrustedSignature(executable)) {
    result.error =
        "The installed application's signature could not be verified";
    return result;
  }
  // Deny replacement and writes while PowerShell opens/executes this script.
  // The directory handle also prevents swapping its path after verification.
  base::File directory_guard(script.DirName(),
                             base::File::FLAG_OPEN | base::File::FLAG_READ |
                                 base::File::FLAG_WIN_BACKUP_SEMANTICS |
                                 base::File::FLAG_WIN_EXCLUSIVE_WRITE);
  base::File script_guard(script, base::File::FLAG_OPEN |
                                      base::File::FLAG_READ |
                                      base::File::FLAG_WIN_EXCLUSIVE_WRITE);
  std::string source;
  const auto* expected_hash = policy.FindString("scriptSha256");
  if (!directory_guard.IsValid() || !script_guard.IsValid() || !expected_hash ||
      !base::ReadFileToStringWithMaxSize(script, &source, kMaximumJsonBytes) ||
      !base::EqualsCaseInsensitiveASCII(
          base::HexEncode(crypto::SHA256HashString(source)), *expected_hash)) {
    result.error =
        "The installed update script does not match its signed policy";
    return result;
  }
  base::CommandLine command(powershell);
  for (const wchar_t* argument : {L"-NoLogo", L"-NoProfile", L"-NonInteractive",
                                  L"-ExecutionPolicy", L"Bypass", L"-File"}) {
    command.AppendArgNative(argument);
  }
  command.AppendArgPath(script);
  command.AppendArgNative(L"-Mode");
  command.AppendArg(mode);
  if (mode == "Install") {
    command.AppendArgNative(L"-ParentProcessId");
    command.AppendArg(base::NumberToString(base::GetCurrentProcId()));
    if (deferred)
      command.AppendArgNative(L"-Deferred");
    if (use_staged)
      command.AppendArgNative(L"-UseStaged");
  }
  base::LaunchOptions options;
  options.start_hidden = true;
  options.current_directory = script.DirName();
  base::FilePath local;
  if (!base::PathService::Get(base::DIR_LOCAL_APP_DATA, &local)) {
    result.error = "Could not locate the update cache";
    return result;
  }
  // The script and native cancellation-path validator must use the same OS
  // directory, even if the launching shell changed LOCALAPPDATA.
  options.environment[L"LOCALAPPDATA"] = local.value();
  std::string output;
  int exit_code = -1;
  bool excessive_output = false;
  size_t bytes_seen = 0;
  base::Process child;
  const bool finished = base::GetAppOutputWithExitCodeAndTimeout(
      command.GetCommandLineString(), false, &output, &exit_code,
      mode == "Stage" || mode == "Install" ? base::Minutes(30)
                                           : base::Minutes(3),
      options,
      [&child, &bytes_seen, &excessive_output](const base::Process& process,
                                               std::string_view chunk) {
        if (!child.IsValid()) {
          child = process.Duplicate();
        }
        bytes_seen += chunk.size();
        if (bytes_seen > kMaximumJsonBytes) {
          excessive_output = true;
          process.Terminate(1, false);
        }
      });
  if (!finished || excessive_output) {
    if (child.IsValid()) {
      child.Terminate(1, false);
    }
    result.error = excessive_output ? "Updater returned excessive output"
                                    : "Updater did not complete in time";
    return result;
  }
  // Windows PowerShell serializes redirected output as UTF-8 on supported
  // systems. Strip its optional UTF-8 BOM before parsing the one JSON object.
  if (output.starts_with("\xEF\xBB\xBF")) {
    output.erase(0, 3);
  }
  auto value = base::JSONReader::ReadDict(output, base::JSON_PARSE_RFC);
  if (!value) {
    result.error = "Updater returned an invalid response";
    return result;
  }
  const std::string* status = value->FindString("status");
  if (exit_code != 0 || !status || *status == "error") {
    const std::string* message = value->FindString("message");
    result.error =
        message ? message->substr(0, 1024) : "Update operation failed";
    return result;
  }
  const std::string* version = value->FindString("currentVersion");
  if (!version || *version != *policy.FindString("appVersion")) {
    result.error = "Updater version does not match the installed signed policy";
    return result;
  }
  const bool valid_status =
      (mode == "State" && *status == "ready" &&
       value->FindBool("configured").value_or(false) &&
       value->FindString("feedUrl") &&
       *value->FindString("feedUrl") == *policy.FindString("feedUrl") &&
       value->FindString("channel") &&
       *value->FindString("channel") == *policy.FindString("channel")) ||
      (mode == "Check" &&
       (*status == "available" || *status == "up-to-date")) ||
      (mode == "Stage" && (*status == "staged" || *status == "up-to-date")) ||
      (mode == "Install" &&
       (*status == "installing" || *status == "up-to-date"));
  if (!valid_status) {
    result.error = "Updater returned an unexpected operation status";
    return result;
  }
  if (*status == "available" || *status == "staged" ||
      *status == "installing" ||
      (mode == "State" && value->FindBool("staged").value_or(false))) {
    const std::string* next_version = value->FindString("version");
    const base::Version current(*version);
    const base::Version next(next_version ? *next_version : "");
    if (!next.IsValid() || next.components().size() < 3 ||
        next.components().size() > 4 || next.CompareTo(current) <= 0) {
      result.error = "Updater did not return a newer release version";
      return result;
    }
  }
  if (*status == "installing") {
    result.cancel_path = ValidatedCancelPath(*value, policy);
    if (result.cancel_path.empty()) {
      result.error = "Updater returned an invalid worker cancellation path";
      return result;
    }
  }
  result.value = std::move(*value);
  return result;
}

UpdaterInitialization ReadInitialState() {
  UpdaterInitialization result;
  // An isolated/test profile must never update the installed application.
  if (base::Environment::Create()->GetVar("BAY_DATA_DIR").value_or("") != "") {
    return result;
  }
  auto policy = EmbeddedPolicy();
  base::FilePath system;
  base::FilePath local;
  if (!policy || !ValidPolicy(*policy) ||
      !base::PathService::Get(base::FILE_EXE, &result.executable) ||
      !base::PathService::Get(base::DIR_SYSTEM, &system) ||
      !base::PathService::Get(base::DIR_LOCAL_APP_DATA, &local)) {
    return result;
  }
  result.policy = std::move(*policy);
  // DIR_SYSTEM comes from the Windows system-directory API. Never resolve
  // powershell.exe through PATH, an environment variable or renderer input.
  result.powershell = system.AppendASCII("WindowsPowerShell")
                          .AppendASCII("v1.0")
                          .AppendASCII("powershell.exe");
  result.script = result.executable.DirName().AppendASCII("update.ps1");
  result.settings =
      local.AppendASCII("Bay").AppendASCII("updater-settings.json");
  base::FilePath real_script;
  base::FilePath real_directory;
  if (!base::PathExists(result.powershell) ||
      !base::NormalizeFilePath(result.script, &real_script) ||
      !base::NormalizeFilePath(result.executable.DirName(), &real_directory) ||
      real_script.DirName() != real_directory) {
    return result;
  }
  auto checked = RunUpdater(result.executable, result.powershell, result.script,
                            result.policy, "State", false, false);
  if (!checked.error.empty()) {
    result.error = std::move(checked.error);
    return result;
  }
  result.configured = true;
  result.staged = checked.value.FindBool("staged").value_or(false);
  if (result.staged)
    result.pending_version = *checked.value.FindString("version");
  std::string settings;
  if (base::ReadFileToStringWithMaxSize(result.settings, &settings,
                                        kMaximumJsonBytes)) {
    if (auto values =
            base::JSONReader::ReadDict(settings, base::JSON_PARSE_RFC)) {
      result.checks = values->FindBool("automaticChecks").value_or(true);
      result.downloads = values->FindBool("automaticDownloads").value_or(false);
      auto last_check = values->FindDouble("lastCheck");
      if (last_check && *last_check > 0 &&
          *last_check <= base::Time::Now().InMillisecondsFSinceUnixEpoch()) {
        result.last_check = last_check;
      }
    }
  }
  return result;
}
}  // namespace

UpdaterService::UpdaterService(EventSink events,
                               base::RepeatingClosure request_quit)
    : events_(std::move(events)),
      request_quit_(std::move(request_quit)),
      worker_(base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::CONTINUE_ON_SHUTDOWN})) {}

UpdaterService::~UpdaterService() = default;

void UpdaterService::Prepare(base::OnceClosure ready) {
  if (ready_) {
    std::move(ready).Run();
    return;
  }
  ready_callbacks_.push_back(std::move(ready));
  if (preparing_) {
    return;
  }
  preparing_ = true;
  worker_->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&ReadInitialState),
      base::BindOnce(&UpdaterService::Prepared, weak_factory_.GetWeakPtr()));
}

void UpdaterService::Prepared(UpdaterInitialization initial) {
  executable_ = std::move(initial.executable);
  powershell_ = std::move(initial.powershell);
  script_ = std::move(initial.script);
  settings_path_ = std::move(initial.settings);
  policy_ = std::move(initial.policy);
  configured_ = initial.configured;
  automatic_checks_ = initial.checks;
  automatic_downloads_ = initial.downloads;
  staged_ = initial.staged;
  pending_version_ = std::move(initial.pending_version);
  last_check_ = initial.last_check;
  error_ = std::move(initial.error);
  status_ = configured_ ? (staged_ ? "staged" : "ready") : "disabled";
  ready_ = true;
  preparing_ = false;
  Publish();
  auto callbacks = std::move(ready_callbacks_);
  for (auto& callback : callbacks) {
    std::move(callback).Run();
  }
  ScheduleAutomaticCheck();
}

base::DictValue UpdaterService::State() const {
  if (!configured_) {
    return base::DictValue().Set("available", false);
  }
  base::DictValue state;
  state.Set("available", true);
  state.Set("configured", true);
  state.Set("automaticChecks", automatic_checks_);
  state.Set("automaticDownloads", automatic_downloads_);
  state.Set("canCheck", !busy_ && !prompting_ && !installing_ && !quitting_ &&
                            cancel_path_.empty());
  state.Set("sessionInProgress",
            busy_ || prompting_ || installing_ || !cancel_path_.empty());
  state.Set("feedURL", *policy_.FindString("feedUrl"));
  state.Set("version", *policy_.FindString("appVersion"));
  state.Set("lastCheck",
            last_check_ ? base::Value(*last_check_) : base::Value());
  state.Set("status", status_);
  state.Set("staged", staged_);
  state.Set("pending", pending_version_.empty()
                           ? base::Value()
                           : base::Value(base::DictValue()
                                             .Set("version", pending_version_)
                                             .Set("ready", staged_)));
  if (!error_.empty()) {
    state.Set("error", error_);
  }
  return state;
}

bool UpdaterService::Dispatch(BrowserWindowInterface* browser,
                              const std::string& method,
                              const base::ListValue& args,
                              Response& callback) {
  if (method == "updaterState") {
    std::move(callback).Run(Success(base::Value(State())));
    return true;
  }
  if (method != "checkForUpdates" && method != "installPendingUpdate" &&
      method != "setAutomaticUpdateChecks" &&
      method != "setAutomaticUpdateDownloads") {
    return false;
  }
  if (!configured_) {
    std::move(callback).Run(
        Failure("Updates are not configured for this copy of Bay"));
    return true;
  }
  if (busy_ || prompting_ || installing_ || quitting_ ||
      !cancel_path_.empty()) {
    std::move(callback).Run(
        Failure("An update operation is already in progress"));
    return true;
  }
  if (method == "checkForUpdates" || method == "installPendingUpdate") {
    if (!args.empty() || !browser) {
      std::move(callback).Run(
          Failure("A manual check requires a browser window"));
      return true;
    }
    prompt_browser_ = browser->GetWeakPtr();
    if (method == "installPendingUpdate" && !pending_version_.empty()) {
      if (staged_) {
        Start(Operation::kInstall, true, std::move(callback));
      } else {
        PromptForUpdate(pending_version_);
        std::move(callback).Run(Success());
      }
    } else {
      Start(Operation::kCheck, true, std::move(callback));
    }
    return true;
  }
  if (args.size() != 1 || !args[0].is_bool()) {
    std::move(callback).Run(Failure("Updater preference must be a boolean"));
    return true;
  }
  SavePreferences(method == "setAutomaticUpdateChecks" ? args[0].GetBool()
                                                       : automatic_checks_,
                  method == "setAutomaticUpdateDownloads"
                      ? args[0].GetBool()
                      : automatic_downloads_,
                  std::move(callback));
  return true;
}

void UpdaterService::Start(Operation operation,
                           bool manual,
                           Response callback) {
  busy_ = true;
  install_in_flight_ = operation == Operation::kInstall ||
                       operation == Operation::kDeferredInstall;
  check_timer_.Stop();
  error_.clear();
  status_ = operation == Operation::kCheck   ? "checking"
            : operation == Operation::kStage ? "downloading"
                                             : "installing";
  Publish();
  const std::string mode = operation == Operation::kCheck   ? "Check"
                           : operation == Operation::kStage ? "Stage"
                                                            : "Install";
  worker_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&RunUpdater, executable_, powershell_, script_,
                     policy_.Clone(), mode,
                     operation == Operation::kDeferredInstall,
                     operation == Operation::kDeferredInstall ||
                         (operation == Operation::kInstall && staged_)),
      base::BindOnce(&UpdaterService::Completed, weak_factory_.GetWeakPtr(),
                     operation, manual, quit_generation_, std::move(callback)));
}

void UpdaterService::Completed(Operation operation,
                               bool manual,
                               uint64_t quit_generation,
                               Response callback,
                               UpdaterCommandResult result) {
  busy_ = false;
  install_in_flight_ = false;
  if (const auto* status = result.value.FindString("status");
      status && (*status == "available" || *status == "installing" ||
                 *status == "staged")) {
    const auto& version = *result.value.FindString("version");
    if (pending_version_ != version)
      staged_ = false;
    pending_version_ = version;
    if (*status != "available")
      staged_ = true;
  }
  if ((operation == Operation::kInstall ||
       operation == Operation::kDeferredInstall) &&
      quit_generation != quit_generation_) {
    // Shutdown may be rejected while the command is still starting its worker.
    // Do not run the old quit continuation or leave that worker armed.
    if (callback)
      std::move(callback).Run(Failure("The update was cancelled"));
    if (!result.cancel_path.empty()) {
      CancelWorker(result.cancel_path);
    } else {
      status_ = staged_ ? "staged" : "ready";
      Publish();
      if (quitting_)
        FinishQuit();
      else
        ScheduleAutomaticCheck();
    }
    return;
  }
  if (!result.cancel_path.empty())
    cancel_path_ = std::move(result.cancel_path);
  if (operation == Operation::kCheck) {
    last_check_ = base::Time::Now().InMillisecondsFSinceUnixEpoch();
    worker_->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::FilePath path, bool checks, bool downloads,
                          std::optional<double> date) {
                         WritePreferences(path, checks, downloads, date);
                       },
                       settings_path_, automatic_checks_, automatic_downloads_,
                       last_check_));
  }
  error_ = std::move(result.error);
  if (!error_.empty()) {
    status_ = "error";
    prompt_browser_.reset();
    Publish();
    if (callback) {
      std::move(callback).Run(Failure(error_));
    }
    if (manual && !quitting_) {
      chrome::ShowWarningMessageBoxAsync(gfx::NativeWindow(),
                                         u"Could not check for updates",
                                         base::UTF8ToUTF16(error_));
    }
    if (operation == Operation::kDeferredInstall ||
        (quitting_ && quit_preparation_pending_)) {
      FinishQuit();
    } else {
      ScheduleAutomaticCheck();
    }
    return;
  }
  status_ = *result.value.FindString("status");
  if (status_ == "staged") {
    staged_ = true;
  } else if (status_ == "up-to-date") {
    staged_ = false;
    pending_version_.clear();
  } else if (status_ == "installing") {
    installing_ = true;
  }
  Publish();
  if (callback) {
    std::move(callback).Run(Success());
  }
  if (operation == Operation::kDeferredInstall) {
    FinishQuit();
    return;
  }
  if (quitting_) {
    if (quit_preparation_pending_)
      FinishQuit();
    return;
  }
  if (operation == Operation::kCheck && status_ == "available") {
    if (manual) {
      PromptForUpdate(*result.value.FindString("version"));
    } else if (automatic_checks_ && automatic_downloads_) {
      Start(Operation::kStage, false, Response());
    }
  } else if (operation == Operation::kInstall && installing_) {
    request_quit_.Run();
  } else if (manual && status_ == "up-to-date" && prompt_browser_) {
    chrome::ShowWarningMessageBoxAsync(
        prompt_browser_->GetWindow()->GetNativeWindow(), u"Bay is up to date",
        u"This is the latest version available on this update channel.");
    prompt_browser_.reset();
  }
  ScheduleAutomaticCheck();
}

void UpdaterService::PromptForUpdate(const std::string& version) {
  if (!prompt_browser_ || quitting_) {
    prompt_browser_.reset();
    return;
  }
  prompting_ = true;
  Publish();
  MessageBoxDialog::Show(
      prompt_browser_->GetWindow()->GetNativeWindow(), u"Update Bay",
      base::UTF8ToUTF16("Bay " + version +
                        " is available. Install it now and restart Bay?"),
      chrome::MESSAGE_BOX_TYPE_QUESTION, u"Install and restart", u"Later", u"",
      base::BindOnce(&UpdaterService::PromptAnswered,
                     weak_factory_.GetWeakPtr()));
}

void UpdaterService::PromptAnswered(chrome::MessageBoxResult answer) {
  prompting_ = false;
  if (answer == chrome::MESSAGE_BOX_RESULT_YES && prompt_browser_ &&
      !quitting_) {
    Start(Operation::kInstall, true, Response());
  } else {
    prompt_browser_.reset();
    Publish();
    ScheduleAutomaticCheck();
  }
}

void UpdaterService::AutomaticCheck() {
  if (!configured_ || !automatic_checks_ || busy_ || prompting_ ||
      installing_ || quitting_ || !cancel_path_.empty()) {
    return;
  }
  Start(Operation::kCheck, false, Response());
}

void UpdaterService::ScheduleAutomaticCheck() {
  if (!configured_ || !automatic_checks_ || busy_ || prompting_ ||
      installing_ || quitting_ || !cancel_path_.empty()) {
    return;
  }
  base::TimeDelta delay = base::Seconds(15);
  if (last_check_) {
    delay = std::max(
        delay, kCheckInterval - (base::Time::Now() -
                                 base::Time::FromMillisecondsSinceUnixEpoch(
                                     static_cast<int64_t>(*last_check_))));
  }
  check_timer_.Start(FROM_HERE, delay, this, &UpdaterService::AutomaticCheck);
}

void UpdaterService::SavePreferences(bool checks,
                                     bool downloads,
                                     Response callback) {
  busy_ = true;
  Publish();
  worker_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&WritePreferences, settings_path_, checks, downloads,
                     last_check_),
      base::BindOnce(&UpdaterService::PreferencesSaved,
                     weak_factory_.GetWeakPtr(), checks, downloads,
                     std::move(callback)));
}

void UpdaterService::PreferencesSaved(bool checks,
                                      bool downloads,
                                      Response callback,
                                      bool success) {
  busy_ = false;
  if (success) {
    automatic_checks_ = checks;
    automatic_downloads_ = downloads;
    if (!checks) {
      check_timer_.Stop();
    }
    std::move(callback).Run(Success());
  } else {
    std::move(callback).Run(Failure("Could not save update preferences"));
  }
  Publish();
  ScheduleAutomaticCheck();
}

void UpdaterService::PrepareForQuit(
    base::OnceCallback<void(bool)> continuation) {
  if (quitting_ && !quit_preparation_pending_) {
    std::move(continuation).Run(true);
    return;
  }
  quit_callbacks_.push_back(std::move(continuation));
  if (quit_preparation_pending_) {
    return;
  }
  quitting_ = true;
  check_timer_.Stop();
  quit_deadline_.Start(FROM_HERE, base::Minutes(3), this,
                       &UpdaterService::QuitTimedOut);
  if (install_in_flight_ || cancelling_worker_) {
    // A cancelled, still-starting worker must acknowledge its marker before a
    // subsequent quit lets its parent process disappear.
    quit_preparation_pending_ = true;
    return;
  }
  if (!cancel_path_.empty() && !installing_) {
    quit_preparation_pending_ = true;
    CancelWorker(cancel_path_);
    return;
  }
  if (configured_ && automatic_checks_ && automatic_downloads_ && staged_ &&
      !busy_ && !installing_) {
    quit_preparation_pending_ = true;
    Start(Operation::kDeferredInstall, false, Response());
  } else {
    FinishQuit();
  }
}

void UpdaterService::CancelQuit() {
  ++quit_generation_;
  quit_deadline_.Stop();
  quitting_ = false;
  quit_preparation_pending_ = false;
  quit_callbacks_.clear();
  installing_ = false;
  status_ = staged_ ? "staged" : "ready";
  if (!cancel_path_.empty() && !cancelling_worker_)
    CancelWorker(cancel_path_);
  Publish();
  ScheduleAutomaticCheck();
}

void UpdaterService::QuitTimedOut() {
  // A late command result must disarm its worker rather than restarting the
  // expired quit attempt after Chrome has resumed the application.
  ++quit_generation_;
  installing_ = false;
  error_ = "Update preparation took too long; the application will remain open";
  status_ = "error";
  if (!cancel_path_.empty() && !cancelling_worker_)
    CancelWorker(cancel_path_);
  FinishQuit(false);
  Publish();
}

void UpdaterService::CancelWorker(const base::FilePath& path) {
  cancel_path_ = path;
  cancelling_worker_ = true;
  busy_ = true;
  worker_->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&WriteCancellation, path),
      base::BindOnce(&UpdaterService::WorkerCancelled,
                     weak_factory_.GetWeakPtr(), path));
}

void UpdaterService::WorkerCancelled(const base::FilePath& path, bool success) {
  cancelling_worker_ = false;
  busy_ = false;
  if (success) {
    if (cancel_path_ == path)
      cancel_path_.clear();
    status_ = staged_ ? "staged" : "ready";
    error_.clear();
    Publish();
    if (quitting_)
      FinishQuit();
    else
      ScheduleAutomaticCheck();
    return;
  }
  // Keep the cancellation path so a later quit retries rather than allowing
  // the unacknowledged worker to install after the process exits.
  error_ = "Could not cancel the pending update worker";
  status_ = "error";
  if (quitting_)
    FinishQuit(false);
  Publish();
}

void UpdaterService::FinishQuit(bool success) {
  quit_deadline_.Stop();
  quit_preparation_pending_ = false;
  if (!success)
    quitting_ = false;
  auto callbacks = std::move(quit_callbacks_);
  for (auto& callback : callbacks) {
    std::move(callback).Run(success);
  }
}

void UpdaterService::Publish() {
  if (events_) {
    events_.Run(State());
  }
}
}  // namespace bay
