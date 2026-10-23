// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/autostart_linux.h"

#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <string_view>
#include <utility>

#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/posix/eintr_wrapper.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/shell_integration_linux.h"

namespace bay {
namespace {
using Result = Autostart::Result;
using Paths = Autostart::Paths;
constexpr char kEntry[] = "bay.desktop";
constexpr char kHeader[] =
    "[Desktop Entry]\nX-Bay-Autostart-Version=1\nType=Application\n"
    "Name=Bay\nTerminal=false\n";
constexpr char kDisabled[] =
    "[Desktop Entry]\nX-Bay-Autostart-Version=1\nHidden=true\n";
constexpr char kCommandSuffix[] = "\" --bay-launch-at-login";
constexpr size_t kMaxEntrySize = 16384;

std::string Success(base::Value value = {}) {
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
scoped_refptr<base::SequencedTaskRunner> DiskRunner() {
  // One queue across documents/profiles, including replacements of a closed
  // host. A write accepted before teardown must precede a later status query.
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}
Paths NativePaths() {
  auto env = base::Environment::Create();
  return {env->GetVar("XDG_CONFIG_HOME"), env->GetVar("HOME"),
          shell_integration_linux::internal::GetChromeExePath()};
}
bool ValidPath(const base::FilePath& path) {
  if (!path.IsAbsolute() || !base::IsStringUTF8(path.value()))
    return false;
  for (char c : path.value()) {
    if (static_cast<unsigned char>(c) < 0x20 || c == 0x7f)
      return false;
  }
  for (const auto& part : path.GetComponents()) {
    if (part == "." || part == "..")
      return false;
  }
  return true;
}
base::FilePath ConfigPath(const Paths& paths) {
  // XDG requires absolute paths; unset, empty and relative values fall back
  // to HOME/.config. Never substitute cwd, passwd or another profile's home.
  if (paths.config_home && !paths.config_home->empty() &&
      paths.config_home->front() == '/') {
    return paths.config_home->find('\0') == std::string::npos
               ? base::FilePath(*paths.config_home)
               : base::FilePath();
  }
  if (!paths.home || paths.home->empty() ||
      paths.home->find('\0') != std::string::npos)
    return {};
  base::FilePath home(*paths.home);
  return ValidPath(home) ? home.Append(".config") : base::FilePath();
}
// Two escaping layers: desktop string unescaping, then Exec argument quoting.
// Percent is doubled for field-code expansion. This is never a shell command.
std::string DesktopExec(const base::FilePath& path) {
  std::string command = "\"";
  for (char c : path.value()) {
    switch (c) {
      case '\\':
        command += "\\\\\\\\";
        break;
      case '"':
      case '$':
      case '`':
        command += "\\\\";
        command += c;
        break;
      case '%':
        command += "%%";
        break;
      default:
        command += c;
    }
  }
  return command + kCommandSuffix;
}
bool ValidExecutablePath(const base::FilePath& path) {
  // '=' is forbidden in the executable name by the desktop entry spec.
  return ValidPath(path) && path.value().find('=') == std::string::npos;
}
bool Installed(const base::FilePath& path) {
  struct stat info;
  return ValidExecutablePath(path) && stat(path.value().c_str(), &info) == 0 &&
         S_ISREG(info.st_mode) && access(path.value().c_str(), X_OK) == 0;
}
// Accept only our canonical format, including a previous installation path.
// A marker alone is insufficient authority to discard custom keys/arguments.
bool ParseEntry(std::string_view entry,
                base::FilePath& executable,
                bool& hidden) {
  if (entry == kDisabled) {
    hidden = true;
    return true;
  }
  const std::string prefix = std::string(kHeader) + "Exec=\"";
  if (!entry.starts_with(prefix))
    return false;
  entry.remove_prefix(prefix.size());
  if (entry.ends_with("\nHidden=false\n")) {
    hidden = false;
    entry.remove_suffix(std::string_view("\nHidden=false\n").size());
  } else if (entry.ends_with("\nHidden=true\n")) {
    hidden = true;
    entry.remove_suffix(std::string_view("\nHidden=true\n").size());
  } else {
    return false;
  }
  if (!entry.ends_with(kCommandSuffix))
    return false;
  entry.remove_suffix(std::string_view(kCommandSuffix).size());
  std::string path;
  while (!entry.empty()) {
    if (entry.starts_with("\\\\\\\\")) {
      path += '\\';
      entry.remove_prefix(4);
    } else if (entry.size() >= 3 && entry.starts_with("\\\\") &&
               (entry[2] == '"' || entry[2] == '$' || entry[2] == '`')) {
      path += entry[2];
      entry.remove_prefix(3);
    } else if (entry.starts_with("%%")) {
      path += '%';
      entry.remove_prefix(2);
    } else {
      const char c = entry.front();
      if (c == '\\' || c == '%' || c == '"' || c == '$' || c == '`')
        return false;
      path += c;
      entry.remove_prefix(1);
    }
  }
  if (path.find('\0') != std::string::npos)
    return false;
  executable = base::FilePath(path);
  return ValidExecutablePath(executable);
}

bool SafeDirectory(int fd, bool owned, bool writable) {
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISDIR(info.st_mode))
    return false;
  if (owned) {
    const mode_t required = S_IRUSR | S_IXUSR | (writable ? S_IWUSR : 0);
    return info.st_uid == geteuid() && !(info.st_mode & (S_IWGRP | S_IWOTH)) &&
           (info.st_mode & required) == required;
  }
  // Root-owned sticky ancestors allow ordinary /tmp-based test/config paths.
  // Other users' directories and writable non-sticky ancestors are refused.
  return (info.st_uid == geteuid() || info.st_uid == 0) &&
         (!(info.st_mode & (S_IWGRP | S_IWOTH)) ||
          (info.st_uid == 0 && (info.st_mode & S_ISVTX)));
}
// Follow ordinary HOME/config-root symlinks, checking opened directories.
// Hold the config FD; its literal autostart child and entry never follow links.
// Entry operations stay relative to the held autostart descriptor.
base::ScopedFD OpenAutostart(const base::FilePath& config,
                             bool create,
                             bool& missing) {
  base::ScopedFD dir(
      HANDLE_EINTR(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)));
  if (!dir.is_valid())
    return {};
  auto parts = config.GetComponents();
  parts.push_back("autostart");
  for (size_t i = 1; i < parts.size(); ++i) {
    if (!SafeDirectory(dir.get(), false, false))
      return {};
    const int flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NONBLOCK |
                      (i == parts.size() - 1 ? O_NOFOLLOW : 0);
    base::ScopedFD next(
        HANDLE_EINTR(openat(dir.get(), parts[i].c_str(), flags)));
    if (!next.is_valid() && errno == ENOENT && create) {
      if (mkdirat(dir.get(), parts[i].c_str(), 0700) != 0 && errno != EEXIST)
        return {};
      next.reset(HANDLE_EINTR(openat(dir.get(), parts[i].c_str(), flags)));
    }
    if (!next.is_valid()) {
      missing = errno == ENOENT;
      return {};
    }
    // The chosen config root and its autostart child must belong to this user.
    if (i >= parts.size() - 2 && !SafeDirectory(next.get(), true, create))
      return {};
    dir = std::move(next);
  }
  return dir;
}
bool SameEntry(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid &&
         a.st_mode == b.st_mode && a.st_nlink == b.st_nlink &&
         a.st_size == b.st_size;
}
bool SafeEntry(const struct stat& info) {
  return S_ISREG(info.st_mode) && info.st_uid == geteuid() &&
         info.st_nlink == 1 && (info.st_mode & S_IRUSR) &&
         !(info.st_mode & (S_IWGRP | S_IWOTH)) && info.st_size >= 0 &&
         info.st_size <= static_cast<off_t>(kMaxEntrySize);
}
Result WriteEntry(int dir,
                  const struct stat* previous,
                  std::string_view content) {
  base::ScopedFD file;
  std::string temporary;
  for (int attempt = 0; attempt < 16; ++attempt) {
    temporary = ".bay-autostart-" + base::NumberToString(base::RandUint64());
    file.reset(HANDLE_EINTR(
        openat(dir, temporary.c_str(),
               O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600)));
    if (file.is_valid() || errno != EEXIST)
      break;
  }
  if (!file.is_valid())
    return Result::kWriteError;
  base::ScopedClosureRunner cleanup(base::BindOnce(
      [](int dir, std::string name) { unlinkat(dir, name.c_str(), 0); }, dir,
      temporary));
  if (!base::WriteFileDescriptor(file.get(), content) ||
      HANDLE_EINTR(fsync(file.get())) != 0)
    return Result::kWriteError;
  struct stat current;
  if (previous) {
    if (fstatat(dir, kEntry, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
        !SameEntry(*previous, current))
      return Result::kConflict;
    if (renameat(dir, temporary.c_str(), dir, kEntry) != 0)
      return Result::kWriteError;
  } else {
    // Atomic no-replace publication: a concurrent custom entry is preserved.
    if (linkat(dir, temporary.c_str(), dir, kEntry, 0) != 0)
      return errno == EEXIST ? Result::kConflict : Result::kWriteError;
  }
  cleanup.RunAndReset();
  // Failure here means the change is visible but crash durability is unknown.
  return HANDLE_EINTR(fsync(dir)) == 0 ? Result::kSuccess : Result::kWriteError;
}
Result NativeUpdate(const Paths& paths, std::optional<bool> enabled) {
  const auto config = ConfigPath(paths);
  if (!ValidPath(config) || config == base::FilePath("/"))
    return Result::kConfigError;
  // Enabling with an unusable wrapper must not create or change anything.
  if (enabled == true && !Installed(paths.executable))
    return Result::kPathError;
  bool missing = false;
  auto dir = OpenAutostart(config.StripTrailingSeparators(),
                           enabled.has_value(), missing);
  if (!dir.is_valid())
    return missing && !enabled ? Result::kNotRegistered : Result::kConfigError;
  struct stat previous;
  bool exists = fstatat(dir.get(), kEntry, &previous, AT_SYMLINK_NOFOLLOW) == 0;
  if (!exists && errno != ENOENT)
    return Result::kConfigError;
  bool hidden = false;
  base::FilePath executable;
  if (exists) {
    if (!SafeEntry(previous))
      return Result::kConfigError;
    base::ScopedFD file(HANDLE_EINTR(openat(
        dir.get(), kEntry, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)));
    struct stat opened;
    if (!file.is_valid() || fstat(file.get(), &opened) != 0 ||
        !SameEntry(previous, opened))
      return Result::kConfigError;
    std::string content;
    char buffer[4096];
    ssize_t count;
    while ((count = HANDLE_EINTR(read(file.get(), buffer, sizeof(buffer)))) >
           0) {
      content.append(buffer, static_cast<size_t>(count));
      if (content.size() > kMaxEntrySize)
        return Result::kConflict;
    }
    if (count < 0)
      return Result::kConfigError;
    if (!ParseEntry(content, executable, hidden))
      return Result::kConflict;
  }
  if (!enabled) {
    if (!exists || hidden)
      return Result::kNotRegistered;
    return Installed(executable) ? Result::kEnabled : Result::kNotFound;
  }
  const std::string content =
      *enabled
          ? std::string(kHeader) + "Exec=" + DesktopExec(paths.executable) +
                "\nHidden=false\n"
          : kDisabled;
  return WriteEntry(dir.get(), exists ? &previous : nullptr, content);
}
std::string ResponseFor(Result result) {
  switch (result) {
    case Result::kSuccess:
      return Success();
    case Result::kEnabled:
      return Success(base::Value("enabled"));
    case Result::kNotRegistered:
      return Success(base::Value("notRegistered"));
    case Result::kNotFound:
      return Success(base::Value("notFound"));
    case Result::kConfigError:
      return Failure("autostart_unavailable",
                     "Bay startup configuration is unsafe or unavailable");
    case Result::kConflict:
      return Failure(
          "autostart_conflict",
          "Bay startup entry was customized or changed concurrently");
    case Result::kPathError:
      return Failure("path_error", "Bay executable or wrapper is unavailable");
    case Result::kWriteError:
      return Failure("autostart_write_failed",
                     "Bay could not save startup settings");
  }
}
}  // namespace

Autostart::Autostart(HostContext context)
    : Autostart(std::move(context), Operations()) {}
Autostart::Autostart(HostContext context, Operations operations)
    : context_(std::move(context)),
      operations_{operations.paths ? std::move(operations.paths)
                                   : base::BindRepeating(&NativePaths),
                  operations.update ? std::move(operations.update)
                                    : base::BindRepeating(&NativeUpdate)} {}
Autostart::~Autostart() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
  auto pending = std::move(pending_);
  for (auto& [request, callback] : pending)
    std::move(callback).Run(
        Failure("host_closed", "The autostart service was closed"));
}
base::ListValue Autostart::SupportedMethods() {
  return base::ListValue()
      .Append("BaySystem.launchAtLoginStatus")
      .Append("BaySystem.setLaunchAtLogin");
}
bool Autostart::Dispatch(const std::string& module,
                         const std::string& method,
                         const base::ListValue& args,
                         Response& callback) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (module != "BaySystem" ||
      (method != "launchAtLoginStatus" && method != "setLaunchAtLogin"))
    return false;
  if (!context_.profile()) {
    std::move(callback).Run(Failure("profile_unavailable",
                                    "The host profile is no longer available"));
    return true;
  }
  const bool setter = method == "setLaunchAtLogin";
  if (args.size() != (setter ? 1u : 0u) || (setter && !args[0].is_bool())) {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid native method arguments"));
    return true;
  }
  std::optional<bool> enabled;
  if (setter)
    enabled = args[0].GetBool();
  const auto request = ++next_request_;
  pending_.emplace(request, std::move(callback));
  if (!DiskRunner()->PostTaskAndReplyWithResult(
          FROM_HERE,
          base::BindOnce(
              [](Operations operations, std::optional<bool> enabled) {
                return operations.update.Run(operations.paths.Run(), enabled);
              },
              operations_, enabled),
          base::BindOnce(&Autostart::Complete, weak_factory_.GetWeakPtr(),
                         request)))
    Settle(request, Failure("autostart_unavailable",
                            "Bay startup worker is unavailable"));
  return true;
}
void Autostart::Complete(uint64_t request, Result result) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  Settle(request, context_.profile()
                      ? ResponseFor(result)
                      : Failure("profile_unavailable",
                                "The host profile is no longer available"));
}
void Autostart::Settle(uint64_t request, std::string response) {
  auto found = pending_.find(request);
  if (found == pending_.end())
    return;
  auto callback = std::move(found->second);
  pending_.erase(found);
  std::move(callback).Run(response);
}
}  // namespace bay
