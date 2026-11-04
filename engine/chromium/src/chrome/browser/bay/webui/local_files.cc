// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/local_files.h"

#include <algorithm>
#include <utility>

#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "build/build_config.h"
#include "chrome/common/chrome_paths.h"
#include "net/base/filename_util.h"
#include "url/gurl.h"

namespace bay {
namespace {
std::string Utf8(const base::FilePath& path) {
#if BUILDFLAG(IS_WIN)
  return path.AsUTF8Unsafe();
#else
  return path.value();
#endif
}
base::FilePath FromUtf8(const std::string& path) {
#if BUILDFLAG(IS_WIN)
  return base::FilePath::FromUTF8Unsafe(path);
#else
  return base::FilePath(path);
#endif
}
// What a tab shows itself: a PDF, an image or a web page.
bool BrowserReadable(const base::FilePath& path) {
  const std::string extension =
      base::ToLowerASCII(Utf8(base::FilePath(path.FinalExtension())));
  for (const char* readable :
       {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp",
        ".svg", ".ico", ".html", ".htm", ".xhtml"}) {
    if (extension == readable)
      return true;
  }
  return false;
}
bool Hidden(const base::FilePath& path) {
  return Utf8(path.BaseName()).starts_with(".");
}
}  // namespace

LocalFileGrants::LocalFileGrants(base::FilePath store)
    : store_(std::move(store)) {}
LocalFileGrants::~LocalFileGrants() = default;

// static
LocalFileGrants& LocalFileGrants::Get() {
  static base::NoDestructor<LocalFileGrants> grants([] {
    base::FilePath root;
    base::PathService::Get(chrome::DIR_USER_DATA, &root);
    return root.AppendASCII("BayDocuments").AppendASCII(
        "local-file-access.json");
  }());
  return *grants;
}

void LocalFileGrants::Load() {
  if (loaded_)
    return;
  loaded_ = true;
  std::string json;
  if (!base::ReadFileToString(store_, &json))
    return;
  const auto saved = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!saved)
    return;
  for (const auto [root, path] : *saved) {
    if (path.is_string())
      grants_[root] = FromUtf8(path.GetString());
  }
}
void LocalFileGrants::Save() {
  base::DictValue saved;
  for (const auto& [root, path] : grants_)
    saved.Set(root, Utf8(path));
  base::CreateDirectory(store_.DirName());
  base::ImportantFileWriter::WriteFileAtomically(
      store_, base::WriteJson(saved).value_or("{}"));
#if BUILDFLAG(IS_POSIX)
  // Which files someone keeps at hand is theirs alone.
  base::SetPosixFilePermissions(store_, 0600);
#endif
}

std::optional<base::DictValue> LocalFileGrants::Grant(
    const base::FilePath& path,
    const std::optional<std::string>& alias) {
  base::AutoLock hold(lock_);
  Load();
  const base::FilePath granted = base::MakeAbsoluteFilePath(path);
  base::File::Info info;
  if (granted.empty() || !base::GetFileInfo(granted, &info) ||
      !base::PathIsReadable(granted)) {
    return std::nullopt;
  }
  grants_[Utf8(granted)] = granted;
  if (alias && !alias->empty())
    grants_[*alias] = granted;
  Save();
  return base::DictValue()
      .Set("path", Utf8(granted))
      .Set("name", Utf8(granted.BaseName()))
      .Set("kind", info.is_directory ? "folder" : "file");
}

std::optional<base::FilePath> LocalFileGrants::Authorized(
    const std::string& root,
    const std::string& relative) {
  base::AutoLock hold(lock_);
  Load();
  const auto found = grants_.find(root);
  if (found == grants_.end() || relative.starts_with("/") ||
      relative.find('\\') != std::string::npos) {
    return std::nullopt;
  }
  for (const auto& part : base::SplitStringPiece(
           relative, "/", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL)) {
    if (part == "..")
      return std::nullopt;
  }
  const base::FilePath base = base::MakeAbsoluteFilePath(found->second);
  if (base.empty())
    return std::nullopt;
  if (relative.empty())
    return base;
  // Resolving symlinks keeps a link inside the folder from reaching out.
  const base::FilePath target =
      base::MakeAbsoluteFilePath(base.Append(FromUtf8(relative)));
  if (target.empty() || (target != base && !base.IsParent(target)))
    return std::nullopt;
  return target;
}

base::DictValue LocalFileGrants::Inspect(const std::string& root,
                                         const std::string& relative) {
  const auto path = Authorized(root, relative);
  if (!path) {
    // No grant here means inaccessible, even if an unrelated file happens to
    // sit at the same synced path.
    return base::DictValue().Set(
        "status", base::PathExists(FromUtf8(root)) ? "inaccessible" : "missing");
  }
  base::File::Info info;
  if (!base::GetFileInfo(*path, &info))
    return base::DictValue().Set("status", "missing");
  if (!base::PathIsReadable(*path))
    return base::DictValue().Set("status", "inaccessible");
  return base::DictValue()
      .Set("status", "available")
      .Set("path", Utf8(*path))
      .Set("name", Utf8(path->BaseName()))
      .Set("kind", info.is_directory ? "folder" : "file")
      .Set("url", net::FilePathToFileURL(*path).spec())
      .Set("browserReadable", !info.is_directory && BrowserReadable(*path));
}

base::DictValue LocalFileGrants::List(const std::string& root,
                                      const std::string& relative) {
  auto access = Inspect(root, relative);
  base::ListValue entries;
  const auto* kind = access.FindString("kind");
  const auto folder = kind && *kind == "folder" ? Authorized(root, relative)
                                                : std::nullopt;
  if (folder) {
    struct Entry {
      bool directory;
      std::string name;
      base::DictValue value;
    };
    std::vector<Entry> found;
    base::FileEnumerator children(
        *folder, false,
        base::FileEnumerator::FILES | base::FileEnumerator::DIRECTORIES);
    for (auto child = children.Next(); !child.empty();
         child = children.Next()) {
      if (Hidden(child))
        continue;
      const std::string name = Utf8(child.BaseName());
      const std::string child_relative =
          relative.empty() ? name : relative + "/" + name;
      // A link back to an ancestor would make the tree endless.
      if (base::IsLink(child) && base::DirectoryExists(child))
        continue;
      if (!Authorized(root, child_relative))
        continue;
      const bool directory = children.GetInfo().IsDirectory();
      found.push_back({directory, name,
                       base::DictValue()
                           .Set("path", Utf8(child))
                           .Set("relativePath", child_relative)
                           .Set("name", name)
                           .Set("kind", directory ? "folder" : "file")});
    }
    std::ranges::sort(found, [](const Entry& a, const Entry& b) {
      if (a.directory != b.directory)
        return a.directory;
      return base::CompareCaseInsensitiveASCII(a.name, b.name) < 0;
    });
    for (auto& entry : found)
      entries.Append(std::move(entry.value));
  }
  return base::DictValue()
      .Set("access", std::move(access))
      .Set("entries", std::move(entries));
}
}  // namespace bay
