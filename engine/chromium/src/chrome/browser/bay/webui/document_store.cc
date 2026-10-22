// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/document_store.h"

#include <algorithm>
#include <map>
#include <utility>

#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "chrome/common/chrome_paths.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#endif

namespace bay {
namespace {

constexpr size_t kMaxDocumentBytes = 64 * 1024 * 1024;

std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(const char* code, const std::string& message) {
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

// Every live store, so a write can reach the others on its folder.
std::map<DocumentStore*, base::WeakPtr<DocumentStore>>& Stores() {
  static base::NoDestructor<
      std::map<DocumentStore*, base::WeakPtr<DocumentStore>>>
      stores;
  return *stores;
}

// True when `path` must not be read or written through.
#if BUILDFLAG(IS_WIN)
// Any reparse point on the way, or an ancestor Windows won't describe.
bool Redirected(base::FilePath path) {
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
#else
// The document folder or file itself as a symlink. Ancestors are not checked:
// symlinked homes (/home -> /var/home on Fedora Silverblue) are ordinary.
bool Redirected(const base::FilePath& path) {
  return base::IsLink(path);
}
#endif

}  // namespace

bool IsValidDocumentName(std::string_view name) {
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

// static
base::FilePath DocumentStore::DefaultDirectory() {
  base::FilePath root;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &root))
    return {};
  return root.AppendASCII("BayDocuments");
}

// static
base::ListValue DocumentStore::SupportedMethods() {
  return base::ListValue()
      .Append("BayShell.readDocument")
      .Append("BayShell.writeDocument")
      .Append("BayShell.saveDocument")
      .Append("BayShell.removeDocument");
}

DocumentStore::DocumentStore(base::FilePath directory,
                             base::RepeatingClosure changed)
    : directory_(std::move(directory)), changed_(std::move(changed)) {
  Stores()[this] = weak_factory_.GetWeakPtr();
}
DocumentStore::~DocumentStore() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  Stores().erase(this);
}

void DocumentStore::Prepare(base::OnceClosure ready) {
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
      FROM_HERE, base::BindOnce(&DocumentStore::Read, directory_),
      base::BindOnce(&DocumentStore::Loaded, weak_factory_.GetWeakPtr()));
}

// static
DocumentStore::Contents DocumentStore::Read(base::FilePath directory) {
  Contents result;
  if (directory.empty() || Redirected(directory) ||
      !base::CreateDirectory(directory) || Redirected(directory)) {
    result.error = "Bay's document directory could not be opened";
    return result;
  }
  base::FileEnumerator files(directory, false, base::FileEnumerator::FILES);
  for (auto file = files.Next(); !file.empty(); file = files.Next()) {
    const auto name = file.BaseName().AsUTF8Unsafe();
    if (!IsValidDocumentName(name))
      continue;
    std::string contents;
    if (Redirected(file) ||
        !base::ReadFileToStringWithMaxSize(file, &contents,
                                           kMaxDocumentBytes) ||
        !base::IsStringUTF8(contents)) {
      result.documents = base::DictValue();
      result.error = "A saved Bay document could not be read: " + name;
      return result;
    }
    result.documents.Set(name, std::move(contents));
  }
  return result;
}

void DocumentStore::Loaded(Contents contents) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  documents_ = std::move(contents.documents);
  error_ = std::move(contents.error);
  ready_ = true;
  preparing_ = false;
  for (auto& callback : std::exchange(ready_callbacks_, {}))
    std::move(callback).Run();
}

bool DocumentStore::Dispatch(const std::string& module,
                             const std::string& method,
                             const base::ListValue& args,
                             Response& callback) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const bool read = method == "readDocument";
  const bool remove = method == "removeDocument";
  const bool write = method == "writeDocument" || method == "saveDocument";
  if (module != "BayShell" || !(read || remove || write))
    return false;
  if (!ready_ || !error_.empty()) {
    std::move(callback).Run(
        Failure("initialization_failed",
                error_.empty() ? "Bay's documents are not ready" : error_));
    return true;
  }
  const auto* name =
      !args.empty() && args[0].is_string() ? &args[0].GetString() : nullptr;
  const auto* contents =
      args.size() > 1 && args[1].is_string() ? &args[1].GetString() : nullptr;
  if (!name || !IsValidDocumentName(*name) || (write && !contents)) {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid native method arguments"));
    return true;
  }
  if (read) {
    const auto* value = documents_.Find(*name);
    std::move(callback).Run(Success(value ? value->Clone() : base::Value()));
    return true;
  }
  std::optional<std::string> value =
      remove ? std::nullopt : std::make_optional(*contents);
  DiskRunner()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&DocumentStore::Write,
                     directory_.Append(base::FilePath::FromUTF8Unsafe(*name)),
                     value),
      base::BindOnce(&DocumentStore::Written, directory_, *name,
                     std::move(value), std::move(callback)));
  return true;
}

// static
bool DocumentStore::Write(base::FilePath path,
                          std::optional<std::string> contents) {
  if (Redirected(path) || base::DirectoryExists(path))
    return false;
  if (contents &&
      (contents->size() > kMaxDocumentBytes || !base::IsStringUTF8(*contents)))
    return false;
  return contents
             ? base::ImportantFileWriter::WriteFileAtomically(path, *contents)
             : base::DeleteFile(path);
}

// static
void DocumentStore::Written(base::FilePath directory,
                            std::string name,
                            std::optional<std::string> contents,
                            Response callback,
                            bool success) {
  if (!success) {
    std::move(callback).Run(
        Failure("document_write_failed", "Bay could not save this document"));
    return;
  }
  std::vector<base::WeakPtr<DocumentStore>> stores;
  for (const auto& [store, weak] : Stores())
    if (store->directory_ == directory)
      stores.push_back(weak);
  for (const auto& store : stores)
    if (store)
      store->Apply(name, contents);
  std::move(callback).Run(Success());
}

void DocumentStore::Apply(std::string_view name,
                          const std::optional<std::string>& contents) {
  // A store still reading gets this write from the folder: its read was
  // queued on the same sequence before or after the write.
  if (!ready_ || !error_.empty())
    return;
  if (contents)
    documents_.Set(name, *contents);
  else
    documents_.Remove(name);
  changed_.Run();
}

}  // namespace bay
