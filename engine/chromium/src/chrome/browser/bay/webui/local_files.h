// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_LOCAL_FILES_H_
#define CHROME_BROWSER_BAY_WEBUI_LOCAL_FILES_H_

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/synchronization/lock.h"
#include "base/values.h"

namespace bay {
// Local files pinned to the sidebar (LocalFileBookmarks in LocalFiles.swift).
// A path is only metadata: access comes from a grant, made when the user picks
// a file or folder in a native dialog or drops one from the desktop. A path
// arriving through sync or from JavaScript grants nothing. Grants persist in
// a private file and are authority only for the granted item and, for a
// folder, what's inside it.
//
// Thread-safe; every method may block on the disk.
class LocalFileGrants {
 public:
  // Grants at `store`, a JSON file.
  explicit LocalFileGrants(base::FilePath store);
  ~LocalFileGrants();
  LocalFileGrants(const LocalFileGrants&) = delete;
  LocalFileGrants& operator=(const LocalFileGrants&) = delete;

  // The process's grants, in the profile directory's BayDocuments.
  static LocalFileGrants& Get();

  // `path` came from a native picker or drop. `alias` keeps an existing pin's
  // root valid after it's reconnected somewhere else. The pin's descriptor,
  // {path, name, kind}, or nothing when it can't be read.
  std::optional<base::DictValue> Grant(const base::FilePath& path,
                                       const std::optional<std::string>& alias);
  // {status, path?, name?, kind?, url?, browserReadable?}: "missing" or
  // "inaccessible" when there's no grant, whatever is at the path.
  base::DictValue Inspect(const std::string& root, const std::string& relative);
  // {access, entries}: a granted folder's visible children, folders first.
  base::DictValue List(const std::string& root, const std::string& relative);
  // The granted item, resolved, or nothing: never outside the grant, by a
  // ".." or by a symlink.
  std::optional<base::FilePath> Authorized(const std::string& root,
                                           const std::string& relative);

 private:
  void Load();
  void Save();

  const base::FilePath store_;
  base::Lock lock_;
  bool loaded_ = false;
  // A root (or its alias) to the path it grants.
  std::map<std::string, base::FilePath> grants_;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_LOCAL_FILES_H_
