#include "SyncService.h"
#include "../../import/windows/ImportCore.h"
#include "RecoveryKit.h"
#include "SyncVault.h"
#include <fstream>
#include <memory>
#include <mutex>
#include <sstream>
#ifdef _WIN32
#include <windows.h>

#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <wrl/client.h>
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#endif
namespace bay::sync {
using Json = nlohmann::json;
namespace fs = std::filesystem;
namespace {
std::mutex stateMutex;
Bytes entropy;
std::unique_ptr<Keys> keys;
std::string configuredDirectory;
ProfileResolver profileResolver;
struct SecretText {
  std::string value;
  ~SecretText() {
    volatile char *bytes = value.empty() ? nullptr : value.data();
    for (std::size_t index = 0; index < value.size(); ++index)
      bytes[index] = 0;
  }
};
void setEntropy(Bytes next) {
  erase(entropy);
  entropy = std::move(next);
  keys = entropy.empty() ? nullptr : std::make_unique<Keys>(entropy);
}
Keys &unlocked() {
  if (!keys)
    throw Failure("locked", "Sync is not set up on this Windows device");
  return *keys;
}
fs::path environment(const wchar_t *name) {
#ifdef _WIN32
  wchar_t value[32768]{};
  auto n = GetEnvironmentVariableW(name, value, 32768);
  return n && n < 32768 ? fs::path(value) : fs::path{};
#else
  (void)name;
  return {};
#endif
}
fs::path dataDirectory() {
  if (!configuredDirectory.empty())
    return fs::u8path(configuredDirectory);
  auto custom = environment(L"BAY_DATA_DIR");
  return custom.empty() ? environment(L"LOCALAPPDATA") / "Bay" : custom;
}
fs::path defaultFolder() {
  auto custom = environment(L"BAY_SYNC_DEFAULT_FOLDER");
  if (!custom.empty())
    return custom;
  auto oneDrive = environment(L"OneDrive");
  if (!oneDrive.empty() && fs::is_directory(oneDrive))
    return oneDrive / "Bay Sync";
#ifdef _WIN32
  PWSTR documents = nullptr;
  if (SUCCEEDED(
          SHGetKnownFolderPath(FOLDERID_Documents, 0, nullptr, &documents))) {
    fs::path result(documents);
    CoTaskMemFree(documents);
    return result / "Bay Sync";
  }
#endif
  return dataDirectory() / "Bay Sync";
}
bool hasSyncData(const fs::path &folder) {
  std::error_code error;
  for (fs::directory_iterator it(folder, error), end; !error && it != end;
       it.increment(error))
    if (isTag(it->path().filename().u8string()) && it->is_directory())
      return true;
  return false;
}
bool writable(const fs::path &folder) {
  auto probe = folder / (".bay-write-" + base32(randomBytes(16)));
  std::ofstream stream(probe, std::ios::binary);
  if (!stream)
    return false;
  stream.close();
  std::error_code ignored;
  fs::remove(probe, ignored);
  return true;
}
std::string deviceName() {
#ifdef _WIN32
  wchar_t name[MAX_COMPUTERNAME_LENGTH + 1]{};
  DWORD n = MAX_COMPUTERNAME_LENGTH + 1;
  if (GetComputerNameW(name, &n))
    return fs::path(name).u8string();
#endif
  return "This Windows device";
}
Json choose(bool folder, const fs::path &current = {}, bool text = false) {
#ifdef _WIN32
  Microsoft::WRL::ComPtr<IFileDialog> dialog;
  auto type = folder ? CLSID_FileOpenDialog : CLSID_FileSaveDialog;
  if (FAILED(CoCreateInstance(type, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&dialog))))
    throw Failure("dialog", "Could not open the file chooser");
  DWORD flags = FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST |
                (folder ? FOS_PICKFOLDERS : FOS_OVERWRITEPROMPT);
  dialog->SetOptions(flags);
  if (!current.empty()) {
    Microsoft::WRL::ComPtr<IShellItem> item;
    if (SUCCEEDED(SHCreateItemFromParsingName(current.c_str(), nullptr,
                                              IID_PPV_ARGS(&item))))
      dialog->SetFolder(item.Get());
  }
  if (!folder) {
    COMDLG_FILTERSPEC filter{text ? L"Recovery text" : L"Recovery PDF",
                             text ? L"*.txt" : L"*.pdf"};
    dialog->SetFileTypes(1, &filter);
    dialog->SetDefaultExtension(text ? L"txt" : L"pdf");
    dialog->SetFileName(text ? L"Bay Recovery Kit.txt"
                             : L"Bay Recovery Kit.pdf");
  }
  auto response = dialog->Show(GetActiveWindow());
  if (response == HRESULT_FROM_WIN32(ERROR_CANCELLED))
    return nullptr;
  if (FAILED(response))
    throw Failure("dialog", "File chooser failed");
  Microsoft::WRL::ComPtr<IShellItem> item;
  dialog->GetResult(&item);
  PWSTR value = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &value)))
    throw Failure("dialog", "Selected item has no local path");
  auto path = fs::path(value).u8string();
  CoTaskMemFree(value);
  return path;
#else
  (void)folder;
  (void)current;
  (void)text;
  return nullptr;
#endif
}
void clipboard(const std::string &text) {
#ifdef _WIN32
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                   static_cast<int>(text.size()), nullptr, 0);
  if (length <= 0)
    throw Failure("clipboard", "Could not encode recovery phrase");
  auto block = GlobalAlloc(GMEM_MOVEABLE, (length + 1) * sizeof(wchar_t));
  if (!block)
    throw Failure("clipboard", "Could not copy recovery phrase");
  auto memory = static_cast<wchar_t *>(GlobalLock(block));
  if (!memory) {
    GlobalFree(block);
    throw Failure("clipboard", "Clipboard memory is unavailable");
  }
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                      memory, length);
  memory[length] = 0;
  GlobalUnlock(block);
  if (!OpenClipboard(GetActiveWindow())) {
    GlobalFree(block);
    throw Failure("clipboard", "Clipboard is busy");
  }
  EmptyClipboard();
  // Prevent the phrase from entering Windows clipboard history and cloud
  // clipboard.
  DWORD disabled = 0;
  for (auto name :
       {L"CanIncludeInClipboardHistory", L"CanUploadToCloudClipboard"}) {
    auto option = GlobalAlloc(GMEM_MOVEABLE, sizeof(disabled));
    if (option) {
      auto data = GlobalLock(option);
      if (data) {
        memcpy(data, &disabled, sizeof(disabled));
        GlobalUnlock(option);
        if (!SetClipboardData(RegisterClipboardFormatW(name), option))
          GlobalFree(option);
      } else
        GlobalFree(option);
    }
  }
  bool ok = SetClipboardData(CF_UNICODETEXT, block) != nullptr;
  CloseClipboard();
  if (!ok) {
    GlobalFree(block);
    throw Failure("clipboard", "Could not copy recovery phrase");
  }
#else
  (void)text;
  throw Failure("unsupported", "Clipboard access requires Windows");
#endif
}
} // namespace
void SetDataDirectory(std::string directory) {
  std::lock_guard<std::mutex> lock(stateMutex);
  configuredDirectory = std::move(directory);
}
void SetProfileResolver(ProfileResolver resolver) {
  std::lock_guard<std::mutex> lock(stateMutex);
  profileResolver = std::move(resolver);
}
std::string Invoke(const std::string &, const std::string &method,
                   const std::string &argsJson) {
  auto args = Json::parse(argsJson);
  Json result;
  if (method == "newDeviceId")
    return Json(base32(randomBytes(16))).dump();
  if (method == "deviceName")
    return Json(deviceName()).dump();
  if (method == "chooseFolder")
    return choose(true, args.empty() || args[0].is_null()
                            ? fs::path{}
                            : fs::u8path(args[0].get<std::string>()))
        .dump();
  if (method == "folderInfo") {
    auto defaultPath = defaultFolder();
    auto path = args.empty() || args[0].is_null()
                    ? defaultPath
                    : fs::u8path(args[0].get<std::string>());
    bool exists = fs::is_directory(path);
    return Json{{"path", path.u8string()},
                {"defaultPath", defaultPath.u8string()},
                {"iCloudAvailable", false},
                {"inICloud", false},
                {"exists", exists},
                {"writable", exists && writable(path)},
                {"hasSyncData", exists && hasSyncData(path)}}
        .dump();
  }
  std::lock_guard<std::mutex> lock(stateMutex);
  if (method == "createPhrase") {
    auto value = randomBytes(32);
    bool saved = saveSecret(args.at(0), value);
    if (saved)
      setEntropy(std::move(value));
    else
      erase(value);
    result = saved;
  } else if (method == "enterPhrase") {
    Bytes next;
    try {
      next = recoveryEntropy(args.at(1));
    } catch (const Failure &error) {
      result = {{"error", error.code}};
      if (error.code == "wordCount")
        result["count"] = std::stoi(error.what());
      else if (error.code == "unknownWord")
        result["word"] = error.what();
      return result.dump();
    }
    Keys candidate(next);
    auto folder = fs::u8path(args.at(2).get<std::string>());
    if (!Vault(folder, candidate).chainExists()) {
      erase(next);
      return Json{{"error", hasSyncData(folder) ? "mismatch" : "noData"}}
          .dump();
    }
    if (!saveSecret(args.at(0), next)) {
      erase(next);
      return Json{{"error", "keychain"}}.dump();
    }
    setEntropy(std::move(next));
    result = {{"ok", true}};
  } else if (method == "unlock") {
    auto saved = loadSecret(args.at(0));
    result = saved && saved->size() == 32;
    if (result.get<bool>())
      setEntropy(std::move(*saved));
    else if (saved)
      erase(*saved);
  } else if (method == "forget") {
    deleteSecret(args.at(0));
    setEntropy({});
  } else if (method == "chainStatus") {
    auto path = fs::u8path(args.at(0).get<std::string>());
    result = !fs::is_directory(path)                 ? "unavailable"
             : Vault(path, unlocked()).chainExists() ? "ok"
                                                     : "missing";
  } else if (method == "createChain") {
    auto folder = fs::u8path(args.at(0).get<std::string>());
    fs::create_directories(folder);
    Vault(folder, unlocked()).createChain();
  } else if (method == "write") {
    auto value = args.at(2).get<std::string>();
    result = Vault(fs::u8path(args.at(0).get<std::string>()), unlocked())
                 .write(args.at(1), Bytes(value.begin(), value.end()));
  } else if (method == "read") {
    auto known = args.at(2).get<std::vector<std::string>>();
    auto listing = Vault(fs::u8path(args.at(0).get<std::string>()), unlocked())
                       .read(args.at(1),
                             std::set<std::string>(known.begin(), known.end()));
    result = {{"files", Json::array()},
              {"pending", listing.pending},
              {"present", listing.present},
              {"damaged", Json::array()}};
    for (auto &file : listing.files)
      result["files"].push_back(
          {{"id", file.id},
           {"payload", std::string(file.payload.begin(), file.payload.end())}});
    for (auto &file : listing.damaged)
      result["damaged"].push_back({{"id", file.id}, {"age", file.age * 1000}});
  } else if (method == "remove")
    Vault(fs::u8path(args.at(0).get<std::string>()), unlocked())
        .remove(args.at(1), args.at(2).get<std::vector<std::string>>());
  else if (method == "deleteChain")
    Vault(fs::u8path(args.at(0).get<std::string>()), unlocked()).deleteChain();
  else if (method == "sealLocal") {
    auto text = args.at(0).get<std::string>();
    result = bay::importer::encodeBase64(
        unlocked().seal(Bytes(text.begin(), text.end()), "local", "state"));
  } else if (method == "openLocal") {
    try {
      auto plain = unlocked().open(bay::importer::decodeBase64(args.at(0)),
                                   "local", "state");
      result = std::string(plain.begin(), plain.end());
      erase(plain);
    } catch (const Failure &) {
      result = nullptr;
    }
  } else if (method == "recoveryWords") {
    unlocked();
    result = recoveryWords(entropy);
  } else if (method == "qrCode" || method == "recoveryKitPreview") {
    unlocked();
    unsigned width =
        method == "recoveryKitPreview"
            ? static_cast<unsigned>(
                  std::clamp(args.at(0).get<double>(), 84.0, 612.0) * 2)
            : 0;
    auto png = method == "qrCode"
                   ? recoveryQrPNG(entropy)
                   : recoveryKitPreviewPNG(entropy, deviceName(), width);
    result = "data:image/png;base64," + bay::importer::encodeBase64(png);
    erase(png);
  } else if (method == "copyRecoveryPhrase") {
    unlocked();
    auto text = recoveryPhrase(entropy);
    clipboard(text);
    std::fill(text.begin(), text.end(), '\0');
  } else if (method == "copyRecoveryKit") {
    unlocked();
#ifdef _WIN32
    copyRecoveryKitFile(
        temporaryRecoveryKit(entropy, deviceName(), dataDirectory()));
#else
    throw Failure("unsupported", "Recovery kit clipboard requires Windows");
#endif
  } else if (method == "saveRecoveryKit") {
    unlocked();
    bool text = args.at(0) == "text";
    auto path = choose(false, {}, text);
    if (!path.is_null()) {
      std::ofstream stream(fs::u8path(path.get<std::string>()),
                           std::ios::binary | std::ios::trunc);
      SecretText content{text ? recoveryKitText(entropy, deviceName())
                              : recoveryKitPDF(entropy, deviceName())};
      stream.write(content.value.data(), content.value.size());
      if (!stream)
        throw Failure("save", "Could not save the recovery kit");
    }
    result = path;
  } else if (method == "shareRecoveryKit") {
    throw Failure("unavailable", "Native sharing is unavailable in this build. "
                                 "Save the recovery kit as a PDF instead");
  } else if (method == "revealFolder") {
#ifdef _WIN32
    auto path = fs::u8path(args.at(0).get<std::string>());
    if (reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", path.c_str(),
                                                nullptr, nullptr,
                                                SW_SHOWNORMAL)) <= 32)
      throw Failure("folder", "Could not open this sync folder");
#endif
  } else if (method == "readPasswords") {
    auto profile = args.at(0).get<std::string>();
    if (profile.find_first_of("/\\:") != std::string::npos || profile == ".." ||
        profile == ".")
      throw Failure("format", "Invalid profile id");
    // Resolve through Chrome rather than guessing user-data/profile paths.
    if (!profileResolver)
      throw Failure("profile_unavailable", "This browser profile is not loaded");
    auto paths = profileResolver(profile);
    if (paths.first.empty() || paths.second.empty())
      throw Failure("profile_unavailable", "This browser profile is not loaded");
    try {
      result = bay::importer::readEnginePasswords(paths.first, paths.second);
    } catch (const std::exception &) {
      result = nullptr;
    }
  } else
    throw Failure("unsupported", "Unknown Windows sync method");
  return result.dump();
}
const std::vector<std::string> &MethodNames() {
  static const std::vector<std::string> methods = {"folderInfo",
                                                   "chooseFolder",
                                                   "newDeviceId",
                                                   "deviceName",
                                                   "createPhrase",
                                                   "enterPhrase",
                                                   "unlock",
                                                   "forget",
                                                   "chainStatus",
                                                   "createChain",
                                                   "write",
                                                   "read",
                                                   "remove",
                                                   "deleteChain",
                                                   "sealLocal",
                                                   "openLocal",
                                                   "recoveryWords",
                                                   "qrCode",
                                                   "recoveryKitPreview",
                                                   "saveRecoveryKit",
                                                   "copyRecoveryKit",
                                                   "copyRecoveryPhrase",
                                                   "revealFolder",
                                                   "readPasswords"};
  return methods;
}
bool RequiresUIThread(const std::string &method) {
  static const std::vector<std::string> methods = {
      "chooseFolder", "saveRecoveryKit", "copyRecoveryKit",
      "copyRecoveryPhrase"};
  return std::find(methods.begin(), methods.end(), method) != methods.end();
}
std::string InvokeEnvelope(const std::string &method,
                           const std::string &argsJson) {
  try {
    auto &methods = MethodNames();
    if (std::find(methods.begin(), methods.end(), method) == methods.end())
      throw Failure("unsupported",
                    "This native method is unavailable on Windows");
    if (!Json::parse(argsJson).is_array())
      throw Failure("invalid_arguments",
                    "Native method arguments must be a JSON array");
    return Json{{"value", Json::parse(Invoke(kModuleName, method, argsJson))}}
        .dump();
  } catch (const Failure &error) {
    return Json{{"error", {{"code", error.code}, {"message", error.what()}}}}
        .dump();
  } catch (const Json::exception &) {
    return Json{{"error",
                 {{"code", "invalid_arguments"},
                  {"message", "Invalid native method arguments"}}}}
        .dump();
  } catch (const std::exception &error) {
    return Json{
        {"error", {{"code", "native_failure"}, {"message", error.what()}}}}
        .dump();
  }
}
} // namespace bay::sync
