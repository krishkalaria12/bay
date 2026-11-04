// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/cli_installer.h"

#include <optional>
#include <map>
#include <string_view>
#include <tuple>
#include <vector>

#include "base/base_paths.h"
#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/synchronization/lock.h"
#include "base/task/bind_post_task.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "chrome/common/chrome_paths.h"
#include "crypto/sha2.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#include "base/base_paths_win.h"
#include "base/win/registry.h"
#else
#include <sys/stat.h>
#endif

namespace bay {
namespace {
constexpr size_t kMaximumBinary = 384 * 1024 * 1024;
constexpr char kState[] = "installed.json";
// UI-sequence, like the documents' host-info snapshots. Callbacks can close a
// window, so installation completion iterates a copy of weak references.
auto& Services() {
  static base::NoDestructor<
      std::map<CliInstallerService*, base::WeakPtr<CliInstallerService>>> services;
  return *services;
}
scoped_refptr<base::SequencedTaskRunner> InstallRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}
#if BUILDFLAG(IS_WIN)
constexpr char kExecutable[] = "bay.exe";
constexpr char kPlatform[] = "windows-x64";
#else
constexpr char kExecutable[] = "bay";
constexpr char kPlatform[] = "linux-x64";
#endif

bool Version(std::string_view text) {
  // The compiled CLI version is metadata, never a path or command argument.
  if (text.empty() || text.size() > 64)
    return false;
  auto dash = text.find('-');
  auto numbers = base::SplitStringPiece(text.substr(0, dash), ".",
                                       base::KEEP_WHITESPACE,
                                       base::SPLIT_WANT_ALL);
  if (numbers.size() != 3)
    return false;
  for (auto number : numbers)
    if (number.empty() || number.find_first_not_of("0123456789") !=
                              std::string_view::npos)
      return false;
  if (dash != std::string_view::npos) {
    auto suffix = text.substr(dash + 1);
    auto dot = suffix.find('.');
    if (dot == 0 || dot == std::string_view::npos || dot + 1 == suffix.size() ||
        suffix.substr(0, dot).find_first_not_of("abcdefghijklmnopqrstuvwxyz") !=
            std::string_view::npos ||
        suffix.substr(dot + 1).find_first_not_of("0123456789") !=
            std::string_view::npos)
      return false;
  }
  return true;
}

bool Plain(const base::FilePath& path, bool directory) {
#if BUILDFLAG(IS_WIN)
  const DWORD attributes = GetFileAttributesW(path.value().c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         !(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
         static_cast<bool>(attributes & FILE_ATTRIBUTE_DIRECTORY) == directory;
#else
  struct stat info;
  return lstat(path.value().c_str(), &info) == 0 &&
         (directory ? S_ISDIR(info.st_mode) : S_ISREG(info.st_mode));
#endif
}

std::optional<base::DictValue> ReadMetadata(const base::FilePath& path) {
  std::string contents;
  if (!Plain(path, false) ||
      !base::ReadFileToStringWithMaxSize(path, &contents, 64 * 1024))
    return std::nullopt;
  return base::JSONReader::ReadDict(contents, base::JSON_PARSE_RFC);
}

std::optional<std::string> Hash(const base::FilePath& path) {
  std::string contents;
  if (!Plain(path, false) ||
      !base::ReadFileToStringWithMaxSize(path, &contents, kMaximumBinary) ||
      contents.empty())
    return std::nullopt;
  return base::HexEncodeLower(crypto::SHA256HashString(contents));
}

std::optional<base::DictValue> Installed(const CliInstaller::Paths& paths) {
  if (!paths.home.IsAbsolute() || !paths.bin.IsAbsolute())
    return std::nullopt;
  auto state = ReadMetadata(paths.home.AppendASCII(kState));
  const auto* version = state ? state->FindString("version") : nullptr;
  const auto* digest = state ? state->FindString("sha256") : nullptr;
  const auto* bin = state ? state->FindString("binPath") : nullptr;
  const auto actual = Hash(paths.bin.AppendASCII(kExecutable));
  if (!version || !Version(*version) || !digest || !bin || !actual ||
      *bin != paths.bin.AppendASCII(kExecutable).AsUTF8Unsafe())
    return std::nullopt;
  if (*actual != *digest) {
    const auto* previous_version = state->FindString("previousVersion");
    const auto* previous_digest = state->FindString("previousSha256");
    if (!previous_version || !Version(*previous_version) ||
        !previous_digest || *actual != *previous_digest)
      return std::nullopt;
    state->Set("version", *previous_version);
    state->Set("sha256", *previous_digest);
  }
  return state;
}

bool AddToPath(const base::FilePath& bin,
               base::FilePath* rc,
               std::string* error) {
#if BUILDFLAG(IS_WIN)
  base::win::RegKey environment(HKEY_CURRENT_USER, L"Environment",
                               KEY_QUERY_VALUE | KEY_SET_VALUE);
  if (!environment.Valid()) {
    *error = "Couldn't open your user environment settings.";
    return false;
  }
  std::wstring current;
  const LONG read = environment.ReadValue(L"Path", &current);
  if (read != ERROR_SUCCESS && read != ERROR_FILE_NOT_FOUND) {
    *error = "Couldn't read your user PATH.";
    return false;
  }
  for (const auto& item : base::SplitStringPiece(
           current, L";", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    std::wstring expanded(32768, L'\0');
    const DWORD count = ExpandEnvironmentStringsW(
        std::wstring(item).c_str(), expanded.data(), expanded.size());
    if (count && count <= expanded.size()) {
      expanded.resize(count - 1);
      if (base::FilePath::CompareEqualIgnoreCase(
              base::FilePath(expanded).StripTrailingSeparators().value(),
              bin.StripTrailingSeparators().value()))
        return true;
    }
  }
  if (bin.value().find_first_of(L";%\r\n") != std::wstring::npos ||
      current.size() + bin.value().size() + 2 > 32767) {
    *error = "The CLI folder cannot be represented in your user PATH.";
    return false;
  }
  if (!current.empty() && current.back() != L';')
    current += L';';
  current += bin.value();
  if (environment.WriteValue(L"Path", current.c_str(), REG_EXPAND_SZ) !=
      ERROR_SUCCESS) {
    *error = "Couldn't add the CLI folder to your user PATH.";
    return false;
  }
  DWORD_PTR ignored;
  SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0,
                      reinterpret_cast<LPARAM>(L"Environment"),
                      SMTO_ABORTIFHUNG, 1000, &ignored);
#else
  auto environment = base::Environment::Create();
  const auto current_path = environment->GetVar("PATH").value_or("");
  for (const auto item : base::SplitStringPiece(
           current_path, ":",
           base::KEEP_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    if (base::FilePath(item).StripTrailingSeparators() ==
        bin.StripTrailingSeparators())
      return true;
  }
  base::FilePath user_home;
  if (!base::PathService::Get(base::DIR_HOME, &user_home)) {
    *error = "Couldn't find your shell's home folder.";
    return false;
  }
  const auto shell = base::FilePath::FromUTF8Unsafe(
      environment->GetVar("SHELL").value_or("/bin/sh")).BaseName().value();
  if (shell == "fish")
    *rc = user_home.AppendASCII(".config/fish/conf.d/bay-cli.fish");
  else if (shell == "zsh")
    *rc = user_home.AppendASCII(".zprofile");
  else if (shell == "bash" && base::PathExists(user_home.AppendASCII(".bash_profile")))
    *rc = user_home.AppendASCII(".bash_profile");
  else if (shell == "bash" && base::PathExists(user_home.AppendASCII(".bash_login")))
    *rc = user_home.AppendASCII(".bash_login");
  else if (shell == "bash" || shell == "sh" || shell == "dash" || shell == "ksh")
    *rc = user_home.AppendASCII(".profile");
  else {
    *error = "Add " + bin.AsUTF8Unsafe() + " to PATH in your shell's login configuration.";
    return false;
  }
  // Literal shell quoting, including a single quote in a custom bin path.
  std::string quoted = bin.AsUTF8Unsafe();
  if (quoted.find_first_of("\r\n") != std::string::npos) {
    *error = "The CLI folder can't contain a newline.";
    return false;
  }
  base::ReplaceSubstringsAfterOffset(&quoted, 0, "'", "'\\''");
  quoted = "'" + quoted + "'";
  const auto line = shell == "fish" ? "fish_add_path -- " + quoted
                                    : "export PATH=" + quoted + ":\"$PATH\"";
  std::string contents;
  if ((base::PathExists(*rc) || base::IsLink(*rc)) &&
      (!Plain(*rc, false) ||
       !base::ReadFileToStringWithMaxSize(*rc, &contents, 1024 * 1024))) {
    *error = "Couldn't safely update " + rc->AsUTF8Unsafe();
    return false;
  }
  if (contents.find(line) == std::string::npos) {
    if (!contents.empty() && contents.back() != '\n')
      contents += '\n';
    contents += "\n# bay command\n" + line + "\n";
    if (!base::CreateDirectory(rc->DirName()) ||
        !base::ImportantFileWriter::WriteFileAtomically(*rc, contents)) {
      *error = "Couldn't update " + rc->AsUTF8Unsafe();
      return false;
    }
  }
#endif
  return true;
}
}  // namespace

CliInstaller::Paths CliInstaller::DefaultPaths() {
  Paths paths;
  base::FilePath executable;
  if (base::PathService::Get(base::DIR_EXE, &executable))
    paths.bundle = executable.AppendASCII("bay-cli");
  auto environment = base::Environment::Create();
  paths.isolated = !environment->GetVar("BAY_DATA_DIR").value_or("").empty();
  auto home = environment->GetVar("BAY_CLI_HOME");
  auto bin = environment->GetVar("BAY_CLI_BIN_DIR");
  if (paths.isolated && (!home || !bin))
    return paths;
  base::FilePath data;
  if (home)
    paths.home = base::FilePath::FromUTF8Unsafe(*home);
  else if (base::PathService::Get(chrome::DIR_USER_DATA, &data))
    paths.home = data.AppendASCII("CLI");
  if (bin)
    paths.bin = base::FilePath::FromUTF8Unsafe(*bin);
#if BUILDFLAG(IS_WIN)
  else
    paths.bin = paths.home.AppendASCII("bin");
#else
  else if (base::PathService::Get(base::DIR_HOME, &data))
    paths.bin = data.AppendASCII(".local").AppendASCII("bin");
#endif
  return paths;
}

base::Value CliInstaller::InstalledVersion(const Paths& paths) {
  // Startup creates a host for each window. Verify an unchanged executable
  // once per process; the installer still checks ownership with a full hash
  // immediately before overwriting a command.
  using Key = std::tuple<std::string, std::string, int64_t, base::Time,
                         int64_t, base::Time>;
  static base::NoDestructor<std::map<Key, std::string>> cache;
  static base::NoDestructor<base::Lock> cache_lock;
  const auto binary = paths.bin.AppendASCII(kExecutable);
  const auto metadata = paths.home.AppendASCII(kState);
  base::File::Info executable_info;
  base::File::Info metadata_info;
  if (!paths.home.IsAbsolute() || !paths.bin.IsAbsolute() ||
      !Plain(binary, false) || !Plain(metadata, false) ||
      !base::GetFileInfo(binary, &executable_info) ||
      !base::GetFileInfo(metadata, &metadata_info))
    return base::Value();
  Key key(paths.home.AsUTF8Unsafe(), paths.bin.AsUTF8Unsafe(),
          executable_info.size, executable_info.last_modified,
          metadata_info.size, metadata_info.last_modified);
  base::AutoLock hold(*cache_lock);
  if (auto it = cache->find(key); it != cache->end())
    return base::Value(it->second);
  auto installed = Installed(paths);
  if (!installed)
    return base::Value();
  const auto version = *installed->FindString("version");
  // Only a few data folders are normally used, but do not retain an entry for
  // every test instance or every version a process has ever installed.
  if (cache->size() >= 16)
    cache->clear();
  cache->emplace(std::move(key), version);
  return base::Value(version);
}

base::DictValue CliInstaller::Install(
    const Paths& paths,
    base::RepeatingCallback<void(std::string)> on_line) {
  // Different window documents can install together. Serialize before checking
  // ownership so an upgrade never sees another window's half-written state.
  static base::NoDestructor<base::Lock> lock;
  base::AutoLock hold(*lock);
  base::DictValue result;
  base::ListValue lines;
  std::string version;
  auto line = [&](std::string text) {
    lines.Append(text);
    if (on_line)
      on_line.Run(std::move(text));
  };
  auto finish = [&](const std::string& error) {
    result.Set("ok", error.empty());
    result.Set("appVersion", version);
    result.Set("installedVersion", InstalledVersion(paths));
    if (!error.empty())
      result.Set("error", error);
    result.Set("lines", std::move(lines));
    return std::move(result);
  };
  if (paths.home.empty() || paths.bin.empty() || !paths.home.IsAbsolute() ||
      !paths.bin.IsAbsolute())
    return finish("A test instance installs only with absolute BAY_CLI_HOME and BAY_CLI_BIN_DIR set.");
  line("step verify");
  auto metadata = ReadMetadata(paths.bundle.AppendASCII("manifest.json"));
  const auto* supplied_version = metadata ? metadata->FindString("version") : nullptr;
  const auto* platform = metadata ? metadata->FindString("platform") : nullptr;
  const auto* digest = metadata ? metadata->FindString("sha256") : nullptr;
  const auto source = paths.bundle.AppendASCII(kExecutable);
  const auto actual = Hash(source);
  if (!supplied_version || !Version(*supplied_version) || !platform ||
      *platform != kPlatform || !digest || !actual || *actual != *digest)
    return finish("This build has no verified bay command. Rebuild the app with its CLI bundle.");
  version = *supplied_version;
  const auto destination = paths.bin.AppendASCII(kExecutable);
  const bool occupied = base::PathExists(destination) || base::IsLink(destination);
  auto previous = Installed(paths);
  if (occupied && !previous)
    return finish(destination.AsUTF8Unsafe() + " already exists and isn't this installation's bay command. Move it first.");
  line("step install");
  if (!base::CreateDirectory(paths.home) || !Plain(paths.home, true) ||
      !base::CreateDirectory(paths.bin) || !Plain(paths.bin, true))
    return finish("Couldn't create the CLI's plain installation folders.");
#if !BUILDFLAG(IS_WIN)
  if (!base::SetPosixFilePermissions(paths.home, 0700))
    return finish("Couldn't protect the CLI's installation folder.");
#endif
  base::FilePath temporary;
  if (!base::CreateTemporaryFileInDir(paths.bin, &temporary))
    return finish("Couldn't stage the bay command.");
  bool copied = base::CopyFile(source, temporary) && Hash(temporary) == *digest;
#if !BUILDFLAG(IS_WIN)
  copied = copied && base::SetPosixFilePermissions(temporary, 0755);
#endif
  if (!copied) {
    base::DeleteFile(temporary);
    return finish("Couldn't stage the verified bay command.");
  }
  base::DictValue state;
  state.Set("version", version);
  state.Set("sha256", *digest);
  state.Set("binPath", destination.AsUTF8Unsafe());
  if (previous) {
    state.Set("previousVersion", *previous->FindString("version"));
    state.Set("previousSha256", *previous->FindString("sha256"));
  }
  // Publish an ownership record that recognizes both the old and new binary
  // before replacing it. A crash or failed move can therefore be retried.
  if (!base::ImportantFileWriter::WriteFileAtomically(
          paths.home.AppendASCII(kState), base::WriteJson(state).value_or(""))) {
    base::DeleteFile(temporary);
    return finish("Couldn't save the CLI installation record.");
  }
  if (!base::ReplaceFile(temporary, destination, nullptr)) {
    base::DeleteFile(temporary);
    return finish("Couldn't replace the bay command. Close any running bay commands and try again.");
  }
  line("step path");
  std::string error;
  base::FilePath rc;
  // An isolated instance must never change the real user's registry.
  if (!paths.isolated && !AddToPath(paths.bin, &rc, &error))
    return finish(error);
  result.Set("binPath", destination.AsUTF8Unsafe());
  result.Set("version", version);
  if (!rc.empty())
    result.Set("rcFile", rc.AsUTF8Unsafe());
  line("installed " + destination.AsUTF8Unsafe());
#if !BUILDFLAG(IS_WIN)
  line("Open a new login shell to use the updated PATH.");
#else
  line("Open a new terminal to use the updated user PATH.");
#endif
  return finish("");
}

CliInstallerService::CliInstallerService(HostContext context,
                                         EventSink events,
                                         base::RepeatingClosure changed)
    : context_(std::move(context)),
      events_(std::move(events)),
      changed_(std::move(changed)) {
  Services()[this] = weak_factory_.GetWeakPtr();
}
CliInstallerService::~CliInstallerService() {
  Services().erase(this);
}

void CliInstallerService::Prepare(base::OnceClosure ready) {
  InstallRunner()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce([] {
        return CliInstaller::InstalledVersion(CliInstaller::DefaultPaths());
      }),
      base::BindOnce(&CliInstallerService::Prepared,
                     weak_factory_.GetWeakPtr(), std::move(ready)));
}

void CliInstallerService::Prepared(base::OnceClosure ready,
                                    base::Value version) {
  installed_version_ = std::move(version);
  ready_ = true;
  std::move(ready).Run();
}

base::DictValue CliInstallerService::Snapshot() const {
  return base::DictValue().Set("installedVersion", installed_version_.Clone());
}

bool CliInstallerService::Dispatch(const std::string& module,
                                    const std::string& method,
                                    const base::ListValue& args,
                                    Response& response) {
  if (module != "BayCli" ||
      (method != "installedVersion" && method != "install"))
    return false;
  if (!args.empty() || !context_.profile()) {
    std::move(response).Run(base::WriteJson(base::DictValue().Set(
        "error", base::DictValue()
                     .Set("code", "invalid_arguments")
                     .Set("message", "The CLI method takes no arguments and needs a live profile.")))
                               .value_or("{}"));
    return true;
  }
  if (method == "installedVersion") {
    std::move(response).Run(base::WriteJson(
        base::DictValue().Set("value", installed_version_.Clone())).value_or("{}"));
    return true;
  }
  auto lines = base::BindPostTaskToCurrentDefault(base::BindRepeating(
      &CliInstallerService::InstallLine, weak_factory_.GetWeakPtr()));
  InstallRunner()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce([](base::RepeatingCallback<void(std::string)> lines) {
        return CliInstaller::Install(CliInstaller::DefaultPaths(), std::move(lines));
      }, std::move(lines)),
      base::BindOnce(&CliInstallerService::Installed,
                     weak_factory_.GetWeakPtr(), std::move(response)));
  return true;
}

void CliInstallerService::InstallLine(std::string line) {
  events_.Run("BayCli", "onInstallLine",
               base::DictValue().Set("line", std::move(line)));
}

void CliInstallerService::Installed(Response response, base::DictValue result) {
  const auto* version = result.Find("installedVersion");
  base::Value installed_version = version ? version->Clone() : base::Value();
  std::vector<base::WeakPtr<CliInstallerService>> services;
  for (const auto& entry : Services())
    services.push_back(entry.second);
  std::move(response).Run(base::WriteJson(
      base::DictValue().Set("value", std::move(result))).value_or("{}"));
  // The response and any host-info notification may destroy any of these
  // services, including this one.
  for (const auto& service : services)
    if (service)
      service->InstallationChanged(installed_version.Clone());
}

void CliInstallerService::InstallationChanged(base::Value version) {
  installed_version_ = std::move(version);
  auto changed = changed_;
  if (changed)
    changed.Run();
}
}  // namespace bay
