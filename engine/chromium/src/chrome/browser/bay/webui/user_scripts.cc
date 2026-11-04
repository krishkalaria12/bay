// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/user_scripts.h"

#include <memory>
#include <optional>
#include <utility>

#include "base/files/file.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_path_watcher.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/bind_post_task.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/timer/timer.h"
#include "build/build_config.h"
#include "chrome/browser/bay/nn_scripts_policy.h"
#include "chrome/common/chrome_paths.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#include "base/win/scoped_handle.h"
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include "base/files/scoped_file.h"
#endif

namespace bay {
namespace {
constexpr size_t kStatusLimit = 1 << 20;

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
bool EnsureDirectory(const base::FilePath& directory) {
  return !directory.empty() &&
         (base::CreateDirectory(directory) && Plain(directory, true));
}
std::optional<std::string> ReadPlain(const base::FilePath& path, size_t limit) {
  if (!Plain(path, false))
    return std::nullopt;
#if BUILDFLAG(IS_WIN)
  base::File file(CreateFileW(path.value().c_str(), GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE |
                                  FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION attributes{};
  if (!file.IsValid() ||
      !GetFileInformationByHandle(file.GetPlatformFile(), &attributes) ||
      attributes.dwFileAttributes &
          (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    return std::nullopt;
#else
  base::File file(open(path.value().c_str(),
                       O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
  struct stat attributes;
  if (!file.IsValid() || fstat(file.GetPlatformFile(), &attributes) != 0 ||
      !S_ISREG(attributes.st_mode))
    return std::nullopt;
#endif
  base::File::Info info;
  if (!file.GetInfo(&info) || info.size < 0 ||
      static_cast<uint64_t>(info.size) > limit)
    return std::nullopt;
  std::string text(static_cast<size_t>(info.size), '\0');
  if (file.ReadAtCurrentPos(base::as_writable_byte_span(text)) != info.size ||
      !base::IsStringUTF8(text))
    return std::nullopt;
  return text;
}
std::optional<double> Generation(const base::FilePath& directory) {
  const auto text = ReadPlain(directory.AppendASCII("generation"), 64);
  if (!text)
    return std::nullopt;
  const auto trimmed = base::TrimWhitespaceASCII(*text, base::TRIM_ALL);
  uint64_t value;
  // Generations cross a JS bridge, so don't round a published integer.
  if (trimmed.empty() ||
      trimmed.find_first_not_of("0123456789") != std::string::npos ||
      !base::StringToUint64(trimmed, &value) || value > 9007199254740991ULL)
    return std::nullopt;
  return static_cast<double>(value);
}
std::string Stamp(const base::FilePath& path) {
  base::File::Info info;
  if (!base::GetFileInfo(path, &info))
    return "-";
  return base::NumberToString(info.creation_time.ToInternalValue()) + ":" +
         base::NumberToString(info.last_modified.ToInternalValue()) + ":" +
         base::NumberToString(info.size);
}
std::string Signature(const base::FilePath& directory) {
  const auto extension = directory.AppendASCII("extension");
  // Status writes change the parent mtime, but must not trigger reconciliation.
  // Source files are published by replacing the extension and generation.
  return ReadPlain(directory.AppendASCII("generation"), 64).value_or("-") +
         "|" + Stamp(extension) + "|" +
         ReadPlain(extension.AppendASCII("generation"), 64).value_or("-");
}

// This must match apps/cli/src/scriptsStore.ts. POSIX File::Lock uses fcntl,
// which does not coordinate with the CLI's flock. Windows locks the first byte.
class SharedLock {
 public:
  explicit SharedLock(const base::FilePath& path) {
#if BUILDFLAG(IS_WIN)
    handle_.Set(CreateFileW(path.value().c_str(), GENERIC_READ | GENERIC_WRITE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                            OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION info{};
    if (handle_.is_valid() &&
        GetFileInformationByHandle(handle_.Get(), &info) &&
        !(info.dwFileAttributes &
          (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
        info.nNumberOfLinks == 1) {
      OVERLAPPED overlap{};
      locked_ = LockFileEx(handle_.Get(), LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0,
                            &overlap);
    }
#else
    fd_.reset(open(path.value().c_str(),
                   O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK,
                   0600));
    struct stat info;
    if (fd_.is_valid() && fstat(fd_.get(), &info) == 0 &&
        S_ISREG(info.st_mode) && info.st_nlink == 1)
      locked_ = flock(fd_.get(), LOCK_SH | LOCK_NB) == 0;
#endif
  }
  ~SharedLock() {
    if (!locked_)
      return;
#if BUILDFLAG(IS_WIN)
    OVERLAPPED overlap{};
    UnlockFileEx(handle_.Get(), 0, 1, 0, &overlap);
#else
    flock(fd_.get(), LOCK_UN);
#endif
  }
  bool locked() const { return locked_; }

 private:
  bool locked_ = false;
#if BUILDFLAG(IS_WIN)
  base::win::ScopedHandle handle_;
#else
  base::ScopedFD fd_;
#endif
};
std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(base::DictValue().Set(
                            "error", base::DictValue()
                                         .Set("code", code)
                                         .Set("message", message)))
      .value_or("{}");
}
}  // namespace

class UserScripts::Watcher {
 public:
  Watcher(base::FilePath directory, base::RepeatingClosure changed)
      : directory_(std::move(directory)), changed_(std::move(changed)) {}
  void SetEnabled(bool enabled) {
    watcher_.reset();
    retry_.Stop();
    if (!enabled)
      return;
    EnsureDirectory(directory_);
    signature_ = Signature(directory_);
    Arm();
    // Also recover when a watcher errors or a CLI writer dies mid-publication.
    retry_.Start(FROM_HERE, base::Seconds(1), this, &Watcher::Poll);
  }

 private:
  void Arm() {
    watcher_ = std::make_unique<base::FilePathWatcher>();
    if (!watcher_->Watch(
            directory_, base::FilePathWatcher::Type::kNonRecursive,
            base::BindRepeating(&Watcher::Changed, base::Unretained(this))))
      watcher_.reset();
  }
  void Poll() {
    if (!watcher_)
      Arm();
    const auto now = Signature(directory_);
    if (now == signature_)
      return;
    signature_ = now;
    changed_.Run();
  }
  void Changed(const base::FilePath&, bool error) {
    // Destruction of the watcher during its callback is supported.
    if (error)
      watcher_.reset();
    Poll();
  }
  const base::FilePath directory_;
  base::RepeatingClosure changed_;
  std::string signature_;
  std::unique_ptr<base::FilePathWatcher> watcher_;
  base::RepeatingTimer retry_;
};

base::FilePath UserScripts::DefaultDirectory() {
  base::FilePath root;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &root))
    return {};
#if BUILDFLAG(IS_MAC)
  root = root.DirName();
#endif
  return root.AppendASCII("Scripts");
}
base::ListValue UserScripts::SupportedMethods() {
  return base::ListValue()
      .Append("BayUserScripts.watch")
      .Append("BayUserScripts.read")
      .Append("BayUserScripts.readStatus")
      .Append("BayUserScripts.writeStatus");
}
UserScripts::UserScripts(base::FilePath directory,
                         base::RepeatingClosure changed)
    : directory_(std::move(directory)),
      disk_(base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE})),
      watcher_(disk_, directory_,
               base::BindPostTaskToCurrentDefault(std::move(changed))) {}
UserScripts::~UserScripts() = default;

base::DictValue UserScripts::Read(const base::FilePath& directory) {
  const auto parent = base::MakeAbsoluteFilePath(directory.DirName());
  const auto extension_path =
      (parent.empty() ? directory : parent.Append(directory.BaseName()))
          .AppendASCII("extension");
  auto invalid = [&](const std::string& error) {
    return base::DictValue()
        .Set("state", "invalid")
        .Set("path", extension_path.AsUTF8Unsafe())
        .Set("generation", Generation(directory).value_or(0))
        .Set("error", error);
  };
  if (!EnsureDirectory(directory))
    return invalid("Scripts isn't a plain folder");
  SharedLock lock(directory.AppendASCII(".lock"));
  if (!lock.locked())
    return base::DictValue().Set("state", "busy");
  base::FileEnumerator journals(directory, false, base::FileEnumerator::FILES,
                                FILE_PATH_LITERAL(".swap-*.json"));
  if (!journals.Next().empty())
    return base::DictValue().Set("state", "pending");
  const auto token = Stamp(directory) + "|" + Signature(directory);
  const auto extension = directory.AppendASCII("extension");
  const auto written = Generation(directory);
  base::DictValue result;
  if (!base::PathExists(extension) && !base::IsLink(extension)) {
    result.Set("state", written ? "absent" : "empty");
    if (written) {
      result.Set("generation", *written);
      result.Set("path", extension_path.AsUTF8Unsafe());
    }
  } else if (!Plain(extension, true)) {
    result = invalid("Scripts/extension isn't a plain folder");
  } else if (const auto generation = Generation(extension);
             !generation || *generation < written.value_or(0)) {
    result.Set("state", "pending");
  } else if (const auto error = ValidateScriptsFolder(extension)) {
    result = invalid(*error);
    result.Set("generation", *generation);
  } else {
    result.Set("state", "ready");
    result.Set("generation", *generation);
    // Canonical path agrees with Chrome's unpacked extension path.
    auto canonical = base::MakeAbsoluteFilePath(extension);
    result.Set("path", (canonical.empty() ? extension : canonical).AsUTF8Unsafe());
  }
  result.Set("token", token);
  return result;
}
base::Value UserScripts::ReadStatus(const base::FilePath& directory) {
  if (!Plain(directory, true))
    return {};
  const auto text = ReadPlain(directory.AppendASCII("status.json"), kStatusLimit);
  return text ? base::Value(*text) : base::Value();
}
bool UserScripts::WriteStatus(const base::FilePath& directory,
                              const std::string& json) {
  if (json.size() > kStatusLimit || !base::IsStringUTF8(json) ||
      !base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC) ||
      !EnsureDirectory(directory))
    return false;
  const auto path = directory.AppendASCII("status.json");
  if (base::IsLink(path) ||
      (base::PathExists(path) && !Plain(path, false)))
    return false;
  return base::ImportantFileWriter::WriteFileAtomically(path, json);
}
bool UserScripts::Dispatch(const std::string& module,
                           const std::string& method,
                           const base::ListValue& args,
                           Response& response) {
  if (module != "BayUserScripts")
    return false;
  if (method == "watch" && args.size() == 1 && args[0].is_bool()) {
    watcher_.AsyncCall(&Watcher::SetEnabled).WithArgs(args[0].GetBool());
    std::move(response).Run(Success());
  } else if ((method == "read" || method == "readStatus") && args.empty()) {
    auto task = method == "read"
                    ? base::BindOnce([](base::FilePath path) {
                        return base::Value(Read(path));
                      }, directory_)
                    : base::BindOnce(&UserScripts::ReadStatus, directory_);
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE, std::move(task),
        base::BindOnce([](Response reply, base::Value value) {
          std::move(reply).Run(Success(std::move(value)));
        }, std::move(response)));
  } else if (method == "writeStatus" && args.size() == 1 && args[0].is_string()) {
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&UserScripts::WriteStatus, directory_,
                                  args[0].GetString()),
        base::BindOnce([](Response reply, bool written) {
          std::move(reply).Run(written ? Success() :
              Failure("write_failed", "Could not write the scripts status"));
        }, std::move(response)));
  } else {
    std::move(response).Run(Failure("invalid_args", "Invalid user script call"));
  }
  return true;
}
}  // namespace bay
