// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_files.h"

#include <utility>

#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "chrome/browser/platform_util.h"
#include "chrome/common/chrome_paths.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>

#include <shellapi.h>
#else
#include <gio/gio.h>
#include <sys/stat.h>
#include "ui/base/glib/scoped_gobject.h"
#endif

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
scoped_refptr<base::SequencedTaskRunner> DiskRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}
scoped_refptr<base::SequencedTaskRunner> TrashRunner() {
#if BUILDFLAG(IS_WIN)
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateCOMSTATaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
#else
  return DiskRunner();
#endif
}
base::Value ReadDownloadsFolder() {
  base::FilePath downloads;
  if (!base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &downloads) ||
      downloads.empty())
    return {};
#if BUILDFLAG(IS_LINUX)
  if (!downloads.IsAbsolute() || !base::IsStringUTF8(downloads.value()) ||
      downloads.value().find('\0') != std::string::npos)
    return {};
  return base::Value(downloads.value());
#else
  return base::Value(downloads.AsUTF8Unsafe());
#endif
}
bool Trash(const base::FilePath& path) {
#if BUILDFLAG(IS_WIN)
  std::wstring source = path.value();
  source.push_back(L'\0');
  source.push_back(L'\0');
  SHFILEOPSTRUCTW operation{};
  operation.wFunc = FO_DELETE;
  operation.pFrom = source.c_str();
  operation.fFlags =
      FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
  return SHFileOperationW(&operation) == 0 && !operation.fAnyOperationsAborted;
#else
  auto file = TakeGObject(g_file_new_for_path(path.value().c_str()));
  // GIO reports unsupported/unavailable trash as false. Never fall back to
  // deletion, including on filesystems without a usable trash directory.
  return g_file_trash(file.get(), nullptr, nullptr);
#endif
}
}  // namespace

ShellFiles::ShellFiles(HostContext context)
    : ShellFiles(std::move(context), Operations()) {}
ShellFiles::ShellFiles(HostContext context, Operations operations)
    : context_(std::move(context)), operations_(std::move(operations)) {
  if (!operations_.trash)
    operations_.trash = base::BindRepeating(&Trash);
  if (!operations_.reveal)
    operations_.reveal = base::BindRepeating(&platform_util::ShowItemInFolder);
  if (!operations_.open) {
    operations_.open = base::BindRepeating(
        [](Profile* profile, const base::FilePath& path, bool directory,
           base::OnceCallback<void(bool)> done) {
          platform_util::OpenItem(
              profile, path,
              directory ? platform_util::OPEN_FOLDER : platform_util::OPEN_FILE,
              base::BindOnce(
                  [](base::OnceCallback<void(bool)> done,
                     platform_util::OpenOperationResult result) {
                    // Chromium verifies the item and submits a launch request.
                    // This does not prove that the external desktop opened it.
                    std::move(done).Run(result ==
                                        platform_util::OPEN_SUCCEEDED);
                  },
                  std::move(done)));
        });
  }
}
ShellFiles::~ShellFiles() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
  auto pending = std::move(pending_);
  for (auto& [request, callback] : pending)
    std::move(callback).Run(
        Failure("host_closed", "The file service was closed"));
}

// static
base::ListValue ShellFiles::SupportedMethods() {
  return base::ListValue()
      .Append("BaySystem.fileExists")
      .Append("BaySystem.downloadsFolder")
      .Append("BaySystem.openFile")
      .Append("BaySystem.revealFile")
      .Append("BaySystem.moveToTrash");
}
void ShellFiles::Prepare(base::OnceClosure ready) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (ready_) {
    std::move(ready).Run();
    return;
  }
  ready_callbacks_.push_back(std::move(ready));
  if (preparing_)
    return;
  preparing_ = true;
  DiskRunner()->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&ReadDownloadsFolder),
      base::BindOnce(&ShellFiles::Prepared, weak_factory_.GetWeakPtr()));
}
void ShellFiles::Prepared(base::Value downloads_folder) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  downloads_folder_ = std::move(downloads_folder);
  ready_ = true;
  preparing_ = false;
  // Callbacks may reenter Prepare or delete the owner. No member access
  // follows.
  auto callbacks = std::move(ready_callbacks_);
  for (auto& callback : callbacks)
    std::move(callback).Run();
}

bool ShellFiles::Dispatch(const std::string& module,
                          const std::string& method,
                          const base::ListValue& args,
                          Response& callback) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (module != "BaySystem" ||
      (method != "fileExists" && method != "downloadsFolder" &&
       method != "openFile" && method != "revealFile" &&
       method != "moveToTrash"))
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
  if (method == "downloadsFolder") {
    std::move(callback).Run(Success(downloads_folder_.Clone()));
    return true;
  }
  const auto* name = args.empty() ? nullptr : args[0].GetIfString();
  if (!name || !base::IsStringUTF8(*name) ||
      name->find('\0') != std::string::npos
#if BUILDFLAG(IS_WIN)
      || name->find_first_of("*?") != std::string::npos
#endif
  ) {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid native method arguments"));
    return true;
  }
#if BUILDFLAG(IS_LINUX)
  // The contract uses UTF-8 native bytes, independently of the process locale.
  auto path = base::FilePath(*name);
#else
  auto path = base::FilePath::FromUTF8Unsafe(*name);
#endif
  if (!path.IsAbsolute()) {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid native method arguments"));
    return true;
  }
#if BUILDFLAG(IS_LINUX)
  if (method == "moveToTrash") {
    // GIO canonicalizes lexically. Dot components or a trailing directory
    // marker could change which entry the kernel resolves across symlinks, or
    // turn an ENOTDIR path into a deletable regular file. Never realpath the
    // final entry: trashing a symlink must trash the link, not its target.
    bool ambiguous = path.value().back() == '/';
    for (const auto& component : path.GetComponents())
      ambiguous |= component == "." || component == "..";
    if (ambiguous) {
      std::move(callback).Run(Failure(
          "invalid_args", "Trash paths must not contain directory markers"));
      return true;
    }
  }
#endif
#if BUILDFLAG(IS_WIN)
  if (method == "revealFile") {
    // Chromium has no completion signal. True means the reveal was requested,
    // even when the desktop later rejects it or the path does not exist.
    auto reveal = operations_.reveal;
    reveal.Run(context_.profile(), path);
    std::move(callback).Run(Success(base::Value(true)));
    return true;
  }
#endif
  const uint64_t request = ++next_request_;
  pending_.emplace(request, std::move(callback));
  auto done = base::BindOnce(&ShellFiles::Complete, weak_factory_.GetWeakPtr(),
                             request);
  if (method == "fileExists") {
    DiskRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&base::PathExists, path), std::move(done));
  } else if (method == "revealFile") {
    DiskRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ShellFiles::Classify, path),
        base::BindOnce(&ShellFiles::Reveal, weak_factory_.GetWeakPtr(), request,
                       path));
  } else if (method == "moveToTrash") {
    TrashRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(operations_.trash, path), std::move(done));
  } else {
#if BUILDFLAG(IS_LINUX)
    // DownloadsPanel opens the downloads directory with openFile(). Resolve
    // type off UI and let OpenItem verify it again when submitting the request.
    DiskRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ShellFiles::Classify, path),
        base::BindOnce(&ShellFiles::Open, weak_factory_.GetWeakPtr(), request,
                       path));
#else
    Open(request, std::move(path), ItemType::kFile);
#endif
  }
  return true;
}
// static
ShellFiles::ItemType ShellFiles::Classify(const base::FilePath& path) {
#if BUILDFLAG(IS_LINUX)
  struct stat info;
  if (stat(path.value().c_str(), &info) != 0)
    return ItemType::kUnavailable;
  // Chromium opens with O_RDONLY during open and portal reveal. A known FIFO
  // can block there; do not submit special nodes. Symlink targets are followed.
  if (S_ISREG(info.st_mode))
    return ItemType::kFile;
  if (S_ISDIR(info.st_mode))
    return ItemType::kDirectory;
#endif
  return ItemType::kUnavailable;
}
void ShellFiles::Open(uint64_t request, base::FilePath path, ItemType type) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!context_.profile()) {
    Settle(request, Failure("profile_unavailable",
                            "The host profile is no longer available"));
    return;
  }
  if (type == ItemType::kUnavailable) {
    Complete(request, false);
    return;
  }
  auto open = operations_.open;
  open.Run(context_.profile(), path, type == ItemType::kDirectory,
           base::BindOnce(&ShellFiles::Complete, weak_factory_.GetWeakPtr(),
                          request));
}
void ShellFiles::Reveal(uint64_t request, base::FilePath path, ItemType type) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (type == ItemType::kUnavailable) {
    Complete(request, false);
    return;
  }
  if (!context_.profile()) {
    Settle(request, Failure("profile_unavailable",
                            "The host profile is no longer available"));
    return;
  }
  auto reveal = operations_.reveal;
  auto weak = weak_factory_.GetWeakPtr();
  reveal.Run(context_.profile(), path);
  // A test backend or desktop integration can synchronously close this owner.
  // Destruction has already settled its pending response in that case.
  if (weak)
    weak->Complete(request, true);
}
void ShellFiles::Complete(uint64_t request, bool result) {
  Settle(request, Success(base::Value(result)));
}
void ShellFiles::Settle(uint64_t request, std::string response) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  auto callback = std::move(pending_.at(request));
  pending_.erase(request);
  std::move(callback).Run(response);
}
}  // namespace bay
