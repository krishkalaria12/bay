// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/webui/shared_folders.h"

#include <map>
#include <memory>
#include <set>
#include <utility>

#include "base/files/file_enumerator.h"
#include "base/files/file_path_watcher.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/string_util.h"
#include "base/synchronization/lock.h"
#include "base/task/bind_post_task.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/common/chrome_paths.h"

namespace bay {
namespace {

constexpr char kGrantsFile[] = "BaySharedFolders.json";
constexpr int64_t kMaxLinkFile = 64 * 1024;
constexpr size_t kMaxEntries = 2000;
constexpr size_t kMaxGrants = 64;

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

bool IsLinkFile(std::string_view name) {
  for (std::string_view extension : {".webloc", ".url", ".desktop"}) {
    if (name.size() > extension.size() &&
        base::EndsWith(name, extension, base::CompareCase::INSENSITIVE_ASCII)) {
      return true;
    }
  }
  return false;
}

base::FilePath GrantsPath() {
  base::FilePath dir;
  return base::PathService::Get(chrome::DIR_USER_DATA, &dir)
             ? dir.AppendASCII(kGrantsFile)
             : base::FilePath();
}

// The grants, process-wide and behind a lock: the picker grants on a blocking
// sequence while every host's operations check them on theirs.
class Grants {
 public:
  static Grants& Get() {
    static base::NoDestructor<Grants> grants;
    return *grants;
  }

  bool Has(const base::FilePath& folder) {
    base::AutoLock hold(lock_);
    Load();
    return paths_.contains(folder.AsUTF8Unsafe());
  }

  bool Add(const base::FilePath& folder) {
    base::AutoLock hold(lock_);
    Load();
    if (!paths_.contains(folder.AsUTF8Unsafe()) &&
        paths_.size() >= kMaxGrants) {
      return false;
    }
    paths_.insert(folder.AsUTF8Unsafe());
    return Save();
  }

  void Remove(const base::FilePath& folder) {
    base::AutoLock hold(lock_);
    Load();
    if (paths_.erase(folder.AsUTF8Unsafe())) {
      Save();
    }
  }

 private:
  void Load() {
    if (loaded_) {
      return;
    }
    loaded_ = true;
    std::string text;
    const base::FilePath path = GrantsPath();
    if (path.empty() ||
        !base::ReadFileToStringWithMaxSize(path, &text, 1 << 20)) {
      return;
    }
    std::optional<base::Value> parsed =
        base::JSONReader::Read(text, base::JSON_PARSE_RFC);
    const base::ListValue* folders = parsed && parsed->is_dict()
                                         ? parsed->GetDict().FindList("folders")
                                         : nullptr;
    for (const base::Value& folder : folders ? *folders : empty_) {
      if (folder.is_string() && paths_.size() < kMaxGrants) {
        paths_.insert(folder.GetString());
      }
    }
  }

  bool Save() {
    base::ListValue folders;
    for (const std::string& path : paths_) {
      folders.Append(path);
    }
    const base::FilePath path = GrantsPath();
    return !path.empty() &&
           base::ImportantFileWriter::WriteFileAtomically(
               path, base::WriteJson(
                         base::DictValue().Set("folders", std::move(folders)))
                         .value_or("{}"));
  }

  base::Lock lock_;
  std::set<std::string> paths_;
  bool loaded_ = false;
  const base::ListValue empty_;
};

base::FilePath FolderArg(const base::ListValue& args, size_t index) {
  return index < args.size() && args[index].is_string()
             ? base::FilePath::FromUTF8Unsafe(args[index].GetString())
             : base::FilePath();
}

}  // namespace

// The folders being watched, on the disk sequence.
class SharedFolders::Watchers {
 public:
  explicit Watchers(base::RepeatingCallback<void(const std::string&)> changed)
      : changed_(std::move(changed)) {}

  void Set(base::FilePath folder, bool on) {
    const std::string key = folder.AsUTF8Unsafe();
    watchers_.erase(key);
    if (!on || !SharedFolders::Granted(folder)) {
      return;
    }
    auto watcher = std::make_unique<base::FilePathWatcher>();
    if (watcher->Watch(folder, base::FilePathWatcher::Type::kNonRecursive,
                       base::BindRepeating(&Watchers::Changed,
                                           base::Unretained(this), key))) {
      watchers_[key] = std::move(watcher);
    }
  }

 private:
  void Changed(const std::string& key, const base::FilePath&, bool error) {
    changed_.Run(key);
  }

  base::RepeatingCallback<void(const std::string&)> changed_;
  std::map<std::string, std::unique_ptr<base::FilePathWatcher>> watchers_;
};

base::ListValue SharedFolders::SupportedMethods() {
  base::ListValue methods;
  for (const char* method :
       {"pick", "read", "write", "remove", "watch", "reveal", "forget"}) {
    methods.Append(std::string("BaySharedFolders.") + method);
  }
  return methods;
}

std::optional<base::DictValue> SharedFolders::Grant(
    const base::FilePath& folder) {
  const base::FilePath absolute = base::MakeAbsoluteFilePath(folder);
  if (absolute.empty() || !base::DirectoryExists(absolute) ||
      !Grants::Get().Add(absolute)) {
    return std::nullopt;
  }
  return base::DictValue()
      .Set("path", absolute.AsUTF8Unsafe())
      .Set("name", absolute.BaseName().AsUTF8Unsafe());
}

bool SharedFolders::Granted(const base::FilePath& folder) {
  return !folder.empty() && folder.IsAbsolute() && Grants::Get().Has(folder);
}

bool SharedFolders::ValidName(std::string_view name) {
  if (name.empty() || name.size() > 255 || name.front() == '.' ||
      !base::IsStringUTF8(name) || !IsLinkFile(name)) {
    return false;
  }
  for (char c : name) {
    if (static_cast<unsigned char>(c) < 0x20 ||
        std::string_view("/\\:*?\"<>|").find(c) != std::string_view::npos) {
      return false;
    }
  }
  return true;
}

base::DictValue SharedFolders::Read(const base::FilePath& folder) {
  if (!Granted(folder)) {
    return base::DictValue().Set("status", "inaccessible");
  }
  if (!base::DirectoryExists(folder)) {
    return base::DictValue().Set("status", "missing");
  }
  base::ListValue entries;
  base::FileEnumerator files(folder, false, base::FileEnumerator::FILES);
  for (base::FilePath path = files.Next();
       !path.empty() && entries.size() < kMaxEntries; path = files.Next()) {
    const std::string name = path.BaseName().AsUTF8Unsafe();
    const base::FileEnumerator::FileInfo info = files.GetInfo();
    std::string text;
    if (!ValidName(name) || base::IsLink(path) ||
        info.GetSize() > kMaxLinkFile ||
        !base::ReadFileToStringWithMaxSize(path, &text, kMaxLinkFile) ||
        !base::IsStringUTF8AllowingNoncharacters(text)) {
      continue;
    }
    entries.Append(
        base::DictValue()
            .Set("name", name)
            .Set("text", std::move(text))
            .Set("modified",
                 info.GetLastModifiedTime().InMillisecondsFSinceUnixEpoch()));
  }
  return base::DictValue()
      .Set("status", "available")
      .Set("entries", std::move(entries));
}

bool SharedFolders::Write(const base::FilePath& folder,
                          const std::string& name,
                          const std::string& text) {
  if (!Granted(folder) || !ValidName(name) ||
      text.size() > static_cast<size_t>(kMaxLinkFile)) {
    return false;
  }
  const base::FilePath path =
      folder.Append(base::FilePath::FromUTF8Unsafe(name));
  return !base::IsLink(path) &&
         base::ImportantFileWriter::WriteFileAtomically(path, text);
}

bool SharedFolders::Remove(const base::FilePath& folder,
                           const std::string& name) {
  if (!Granted(folder) || !ValidName(name)) {
    return false;
  }
  const base::FilePath path =
      folder.Append(base::FilePath::FromUTF8Unsafe(name));
  return !base::PathExists(path) || MoveToTrash(path) || base::DeleteFile(path);
}

void SharedFolders::Forget(const base::FilePath& folder) {
  Grants::Get().Remove(folder);
}

SharedFolders::SharedFolders(
    base::RepeatingCallback<void(const std::string&)> changed)
    : disk_(base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE})),
      watchers_(disk_, base::BindPostTaskToCurrentDefault(std::move(changed))) {
}

SharedFolders::~SharedFolders() = default;

bool SharedFolders::Dispatch(const std::string& module,
                             const std::string& method,
                             const base::ListValue& args,
                             Response& response) {
  if (module != "BaySharedFolders") {
    return false;
  }
  const base::FilePath folder = FolderArg(args, 0);
  auto text = [&](size_t index) {
    return index < args.size() && args[index].is_string()
               ? args[index].GetString()
               : std::string();
  };
  auto answer = [](Response response, base::Value value) {
    std::move(response).Run(Success(std::move(value)));
  };
  if (method == "read") {
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath folder) {
              return base::Value(SharedFolders::Read(folder));
            },
            folder),
        base::BindOnce(answer, std::move(response)));
  } else if (method == "write" || method == "remove") {
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](bool write, base::FilePath folder, std::string name,
               std::string text) {
              return base::Value(write
                                     ? SharedFolders::Write(folder, name, text)
                                     : SharedFolders::Remove(folder, name));
            },
            method == "write", folder, text(1), text(2)),
        base::BindOnce(answer, std::move(response)));
  } else if (method == "watch") {
    const bool on = args.size() > 1 && args[1].is_bool() && args[1].GetBool();
    watchers_.AsyncCall(&Watchers::Set).WithArgs(folder, on);
    std::move(response).Run(Success());
  } else if (method == "forget") {
    watchers_.AsyncCall(&Watchers::Set).WithArgs(folder, false);
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath folder) {
              SharedFolders::Forget(folder);
              return base::Value();
            },
            folder),
        base::BindOnce(answer, std::move(response)));
  } else {
    std::move(response).Run(
        Failure("unsupported_method", "Unknown shared folder method"));
  }
  return true;
}

}  // namespace bay
