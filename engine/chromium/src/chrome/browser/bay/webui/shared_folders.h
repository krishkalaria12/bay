// Copyright 2026 Bay. Apache-2.0.
//
// Folders that stay shared (apps/browser lib/sharedFolders.ts): a pinned
// folder bound to a real folder of link files (.webloc, .url, .desktop) that a
// synced folder (OneDrive, Dropbox, Nextcloud…) shares with other people.
//
// A folder is reachable only once the person picked it in the folder picker
// (BaySharedFolders.pick, through ShellUI): the grants are kept in
// <user data>/BaySharedFolders.json. Inside a granted folder the app reads,
// writes and removes link files by name only (no paths, no other kinds of
// file), and watches the folder for changes, which come back as
// BaySharedFolders.onChange {path}.

#ifndef CHROME_BROWSER_BAY_WEBUI_SHARED_FOLDERS_H_
#define CHROME_BROWSER_BAY_WEBUI_SHARED_FOLDERS_H_

#include <optional>
#include <string>
#include <string_view>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/threading/sequence_bound.h"
#include "base/values.h"

namespace base {
class SequencedTaskRunner;
}

namespace bay {

class SharedFolders {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  static base::ListValue SupportedMethods();

  // Grants a folder the person picked; {path, name}, or nullopt if it isn't
  // a folder. Blocks on the disk.
  static std::optional<base::DictValue> Grant(const base::FilePath& folder);

  // `changed` runs on the calling sequence with a watched folder's path.
  explicit SharedFolders(
      base::RepeatingCallback<void(const std::string&)> changed);
  ~SharedFolders();
  SharedFolders(const SharedFolders&) = delete;
  SharedFolders& operator=(const SharedFolders&) = delete;

  // read, write, remove, watch and forget (pick and reveal need a window and
  // are the host's). False leaves `response` untouched.
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& response);

  // Blocking operations, exposed for tests.
  static bool Granted(const base::FilePath& folder);
  static bool ValidName(std::string_view name);
  // {status: "available"|"missing"|"inaccessible", entries: [{name, text,
  // modified}]}: the folder's link files, up to 64 KiB each.
  static base::DictValue Read(const base::FilePath& folder);
  static bool Write(const base::FilePath& folder,
                    const std::string& name,
                    const std::string& text);
  static bool Remove(const base::FilePath& folder, const std::string& name);
  static void Forget(const base::FilePath& folder);

 private:
  class Watchers;
  const scoped_refptr<base::SequencedTaskRunner> disk_;
  base::SequenceBound<Watchers> watchers_;
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_SHARED_FOLDERS_H_
