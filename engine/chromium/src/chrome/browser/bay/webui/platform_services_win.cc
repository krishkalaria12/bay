// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/platform_services_win.h"
#include "chrome/browser/bay/webui/notifications.h"
#include "chrome/browser/bay/webui/shell_ui.h"

#include <windows.h>

#include <shellapi.h>
#include <wincred.h>

#include <algorithm>
#include <map>
#include <optional>
#include <string_view>
#include <utility>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/environment.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
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
#include "chrome/browser/ui/simple_message_box.h"
#include "chrome/common/chrome_paths.h"
#include "components/version_info/version_info.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/base_window.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/base/mojom/menu_source_type.mojom.h"
#include "ui/display/screen.h"
#include "ui/gfx/codec/jpeg_codec.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/menus/simple_menu_model.h"
#include "ui/native_theme/native_theme.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "ui/views/controls/menu/menu_runner.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace bay {
namespace {
using Response = PlatformServices::Response;
constexpr wchar_t kRunKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kLoginName[] = L"Bay";
constexpr size_t kMaxDocumentBytes = 64 * 1024 * 1024;

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

bool ValidDocument(std::string_view name) {
  if (name.empty() || !base::IsStringUTF8(name) || name == "." ||
      name == ".." ||
      name.find_first_of("/\\:<>\"|?*") != std::string_view::npos ||
      name.back() == '.' || name.back() == ' ' ||
      std::any_of(name.begin(), name.end(),
                  [](unsigned char c) { return c < 32; }))
    return false;
  std::string stem = base::ToUpperASCII(name.substr(0, name.find('.')));
  if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL")
    return false;
  if (stem.size() == 4 &&
      (stem.starts_with("COM") || stem.starts_with("LPT")) && stem[3] >= '1' &&
      stem[3] <= '9')
    return false;
  return true;
}
bool HasReparseAncestor(base::FilePath path) {
  while (!path.empty()) {
    DWORD attributes = GetFileAttributesW(path.value().c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      const DWORD error = GetLastError();
      // Missing targets are expected when creating or removing a document.
      // Access errors must not make a path appear safe.
      if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
        return true;
    } else if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      return true;
    }
    auto parent = path.DirName();
    if (parent == path)
      break;
    path = std::move(parent);
  }
  return false;
}
base::FilePath DocumentDirectory() {
  base::FilePath root;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &root))
    return {};
  return root.AppendASCII("BayDocuments");
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
struct PreparedData {
  base::DictValue snapshots;
  std::string error;
};
PreparedData ReadInitialData(base::FilePath directory,
                             std::string locale,
                             base::DictValue environment) {
  PreparedData result;
  result.snapshots.Set("BayApp",
                       base::DictValue()
                           .Set("systemInfo", SystemInfo(locale))
                           .Set("environment", std::move(environment)));
  if (directory.empty() || HasReparseAncestor(directory) ||
      !base::CreateDirectory(directory) || HasReparseAncestor(directory)) {
    result.error = "Bay's document directory could not be opened";
    return result;
  }
  base::DictValue documents;
  base::FileEnumerator files(directory, false, base::FileEnumerator::FILES);
  for (auto file = files.Next(); !file.empty(); file = files.Next()) {
    const auto name = file.BaseName().AsUTF8Unsafe();
    if (!ValidDocument(name))
      continue;
    std::string contents;
    if (HasReparseAncestor(file) ||
        !base::ReadFileToStringWithMaxSize(file, &contents,
                                           kMaxDocumentBytes) ||
        !base::IsStringUTF8(contents)) {
      result.error = "A saved Bay document could not be read: " + name;
      return result;
    }
    documents.Set(name, std::move(contents));
  }
  result.snapshots.Set(
      "BayShell", base::DictValue().Set("documents", std::move(documents)));
  base::FilePath downloads;
  base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &downloads);
  result.snapshots.Set(
      "BaySystem",
      base::DictValue().Set("downloadsFolder",
                            downloads.empty()
                                ? base::Value()
                                : base::Value(downloads.AsUTF8Unsafe())));
  return result;
}

bool WriteDocument(base::FilePath path, std::optional<std::string> contents) {
  if (HasReparseAncestor(path))
    return false;
  const DWORD attributes = GetFileAttributesW(path.value().c_str());
  if (attributes != INVALID_FILE_ATTRIBUTES &&
      (attributes & FILE_ATTRIBUTE_DIRECTORY))
    return false;
  if (contents &&
      (contents->size() > kMaxDocumentBytes || !base::IsStringUTF8(*contents)))
    return false;
  return contents
             ? base::ImportantFileWriter::WriteFileAtomically(path, *contents)
             : base::DeleteFile(path);
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

class PlatformServices::FilePicker final
    : public ui::SelectFileDialog::Listener {
 public:
  FilePicker(gfx::NativeWindow parent,
             Response response,
             base::OnceClosure done)
      : response_(std::move(response)), done_(std::move(done)) {
    dialog_ = ui::SelectFileDialog::Create(this, nullptr);
    parent_ = parent;
  }
  ~FilePicker() override { dialog_->ListenerDestroyed(); }
  void Show() {
    dialog_->SelectFile(ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE,
                        u"Open files", base::FilePath(), nullptr, 0,
                        base::FilePath::StringType(), parent_, nullptr);
  }
  void FileSelected(const ui::SelectedFileInfo& file, int) override {
    base::ListValue files;
    files.Append(file.path().AsUTF8Unsafe());
    Complete(std::move(files));
  }
  void MultiFilesSelected(
      const std::vector<ui::SelectedFileInfo>& selected) override {
    base::ListValue files;
    for (const auto& file : selected)
      files.Append(file.path().AsUTF8Unsafe());
    Complete(std::move(files));
  }
  void FileSelectionCanceled() override { Complete(base::ListValue()); }

 private:
  void Complete(base::ListValue files) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                             std::move(done_));
    if (response_)
      std::move(response_).Run(Success(base::Value(std::move(files))));
  }
  gfx::NativeWindow parent_;
  scoped_refptr<ui::SelectFileDialog> dialog_;
  Response response_;
  base::OnceClosure done_;
};

class PlatformServices::ContextMenu final
    : public ui::SimpleMenuModel::Delegate {
 public:
  explicit ContextMenu(base::OnceClosure done)
      : done_(std::move(done)), model_(this) {}

  bool Build(const base::ListValue& items) {
    return BuildModel(items, model_, 0);
  }

  void Show(views::Widget* parent, Response response) {
    response_ = std::move(response);
    if (model_.GetItemCount() == 0) {
      Closed();
      return;
    }
    runner_ = std::make_unique<views::MenuRunner>(
        &model_, views::MenuRunner::CONTEXT_MENU,
        base::BindRepeating(&ContextMenu::Closed, base::Unretained(this)));
    runner_->RunMenuAt(
        parent, nullptr,
        gfx::Rect(display::Screen::Get()->GetCursorScreenPoint(), gfx::Size()),
        views::MenuAnchorPosition::kTopLeft, ui::mojom::MenuSourceType::kMouse);
  }

  bool IsCommandIdEnabled(int command_id) const override {
    auto it = commands_.find(command_id);
    return it != commands_.end() && it->second.enabled;
  }
  bool IsCommandIdChecked(int command_id) const override {
    auto it = commands_.find(command_id);
    return it != commands_.end() && it->second.checked;
  }
  void ExecuteCommand(int command_id, int) override {
    auto it = commands_.find(command_id);
    if (it != commands_.end() && it->second.enabled)
      selected_ = it->second.id;
  }

 private:
  struct Command {
    std::string id;
    bool enabled;
    bool checked;
  };

  bool BuildModel(const base::ListValue& items,
                  ui::SimpleMenuModel& model,
                  unsigned depth) {
    if (depth > 16)
      return false;
    for (const auto& value : items) {
      if (++item_count_ > 1000)
        return false;
      const auto* item = value.GetIfDict();
      if (!item)
        return false;
      if (item->FindBool("separator").value_or(false)) {
        model.AddSeparator(ui::NORMAL_SEPARATOR);
        continue;
      }
      const auto* id = item->FindString("id");
      const auto* title = item->FindString("title");
      if (!id || !title || commands_.size() >= 1000)
        return false;
      const int command_id = static_cast<int>(commands_.size()) + 1;
      commands_.emplace(command_id,
                        Command{*id, item->FindBool("enabled").value_or(true),
                                item->FindBool("checked").value_or(false)});
      if (const auto* children = item->FindList("children")) {
        auto submenu = std::make_unique<ui::SimpleMenuModel>(this);
        if (!BuildModel(*children, *submenu, depth + 1))
          return false;
        model.AddSubMenu(command_id, base::UTF8ToUTF16(*title), submenu.get());
        submenus_.push_back(std::move(submenu));
      } else if (item->FindBool("checked").has_value()) {
        model.AddCheckItem(command_id, base::UTF8ToUTF16(*title));
      } else {
        model.AddItem(command_id, base::UTF8ToUTF16(*title));
      }
    }
    return true;
  }
  void Closed() {
    if (!response_)
      return;
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                             std::move(done_));
    std::move(response_).Run(
        Success(selected_ ? base::Value(*selected_) : base::Value()));
  }

  Response response_;
  base::OnceClosure done_;
  std::map<int, Command> commands_;
  size_t item_count_ = 0;
  std::optional<std::string> selected_;
  std::vector<std::unique_ptr<ui::SimpleMenuModel>> submenus_;
  ui::SimpleMenuModel model_;
  // Destroy the runner before its model and delegate.
  std::unique_ptr<views::MenuRunner> runner_;
};

PlatformServices::PlatformServices(HostContext context,
                                   base::RepeatingClosure changed)
    : context_(std::move(context)),
      snapshots_changed_(std::move(changed)),
      disk_runner_(DiskRunner()),
      document_directory_(DocumentDirectory()) {
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
      base::BindOnce(&ReadInitialData, document_directory_,
                     g_browser_process->GetApplicationLocale(),
                     EnvironmentSnapshot()),
      base::BindOnce(
          [](base::WeakPtr<PlatformServices> self, PreparedData result) {
            if (self)
              self->Prepared(std::move(result.snapshots),
                             std::move(result.error));
          },
          weak_factory_.GetWeakPtr()));
}
void PlatformServices::Prepared(base::DictValue snapshots, std::string error) {
  snapshots_ = std::move(snapshots);
  initialization_error_ = std::move(error);
  ready_ = true;
  preparing_ = false;
  auto callbacks = std::move(ready_callbacks_);
  for (auto& callback : callbacks)
    std::move(callback).Run();
}
base::DictValue PlatformServices::Snapshots() const {
  return snapshots_.Clone();
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
                     "BayShell.readDocument",
                     "BayShell.writeDocument",
                     "BayShell.saveDocument",
                     "BayShell.removeDocument",
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
                     "BayApp.notificationPermission",
                     "BayApp.requestNotificationPermission",
                     "BayApp.postNotification",
                     "BayApp.removeNotifications",
                     "BayApp.openNotificationSettings",
                     "BayKeychain.get",
                     "BayKeychain.set",
                     "BayKeychain.delete"})
    methods.Append(name);
  return methods;
}
void PlatformServices::ApplyDocument(
    std::string_view name,
    const std::optional<std::string>& contents) {
  auto* documents = snapshots_.FindDictByDottedPath("BayShell.documents");
  if (!documents)
    return;
  if (contents)
    documents->Set(name, *contents);
  else
    documents->Remove(name);
  snapshots_changed_.Run();
}
void PlatformServices::DocumentWritten(std::string name,
                                       std::optional<std::string> contents,
                                       Response callback,
                                       bool success) {
  if (!success) {
    std::move(callback).Run(
        Failure("document_write_failed", "Bay could not save this document"));
    return;
  }
  std::vector<base::WeakPtr<PlatformServices>> services;
  for (const auto& entry : Services())
    services.push_back(entry.second);
  for (const auto& service : services)
    if (service)
      service->ApplyDocument(name, contents);
  std::move(callback).Run(Success());
}
void PlatformServices::FilePickerFinished() {
  file_picker_.reset();
}
void PlatformServices::ContextMenuFinished() {
  context_menu_.reset();
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
  if (module == "BayShell" &&
      (method == "showMenu" || method == "pickFiles" || method == "confirm") &&
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
  if (module == "BayShell" && method == "showMenu") {
    const auto* value = At(args, 0);
    if (!value || !value->is_list()) {
      invalid();
      return true;
    }
    if (context_menu_) {
      std::move(callback).Run(
          Failure("menu_busy", "A context menu is already open"));
      return true;
    }
    auto* widget = views::Widget::GetWidgetForNativeWindow(
        context_.window()->GetWindow()->GetNativeWindow());
    if (!widget) {
      std::move(callback).Run(
          Failure("window_unavailable", "Bay's window is unavailable"));
      return true;
    }
    auto menu = std::make_unique<ContextMenu>(base::BindOnce(
        &PlatformServices::ContextMenuFinished, weak_factory_.GetWeakPtr()));
    if (!menu->Build(value->GetList())) {
      invalid();
      return true;
    }
    context_menu_ = std::move(menu);
    context_menu_->Show(widget, std::move(callback));
    return true;
  }
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
  if (module == "BayShell" &&
      (method == "readDocument" || method == "writeDocument" ||
       method == "saveDocument" || method == "removeDocument")) {
    const auto* name = Text(args, 0);
    const auto* contents = Text(args, 1);
    if (!name || !ValidDocument(*name) ||
        ((method == "writeDocument" || method == "saveDocument") &&
         !contents)) {
      invalid();
      return true;
    }
    if (method == "readDocument") {
      const auto* documents =
          snapshots_.FindDictByDottedPath("BayShell.documents");
      const auto* value = documents->Find(*name);
      std::move(callback).Run(Success(value ? value->Clone() : base::Value()));
    } else {
      std::optional<std::string> value = method == "removeDocument"
                                             ? std::nullopt
                                             : std::make_optional(*contents);
      disk_runner_->PostTaskAndReplyWithResult(
          FROM_HERE,
          base::BindOnce(
              &WriteDocument,
              document_directory_.Append(base::FilePath::FromUTF8Unsafe(*name)),
              value),
          base::BindOnce(&PlatformServices::DocumentWritten, *name,
                         std::move(value), std::move(callback)));
    }
    return true;
  }
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
  if (module == "BayShell" && method == "pickFiles") {
    if (file_picker_) {
      std::move(callback).Run(
          Failure("dialog_busy", "A file picker is already open"));
      return true;
    }
    file_picker_ = std::make_unique<FilePicker>(
        context_.window()->GetWindow()->GetNativeWindow(), std::move(callback),
        base::BindOnce(&PlatformServices::FilePickerFinished,
                       weak_factory_.GetWeakPtr()));
    file_picker_->Show();
    return true;
  }
  if (module == "BayShell" && method == "confirm") {
    const auto* options = Object(args, 0);
    if (!options) {
      invalid();
      return true;
    }
    chrome::ShowQuestionMessageBoxAsync(
        context_.window()->GetWindow()->GetNativeWindow(),
        base::UTF8ToUTF16(options->FindString("title")
                              ? *options->FindString("title")
                              : "Bay"),
        base::UTF8ToUTF16(options->FindString("message")
                              ? *options->FindString("message")
                              : ""),
        base::BindOnce(
            [](Response callback, chrome::MessageBoxResult result) {
              std::move(callback).Run(Success(
                  base::Value(base::DictValue()
                                  .Set("confirmed",
                                       result == chrome::MESSAGE_BOX_RESULT_YES)
                                  .Set("suppressed", false))));
            },
            std::move(callback)));
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
