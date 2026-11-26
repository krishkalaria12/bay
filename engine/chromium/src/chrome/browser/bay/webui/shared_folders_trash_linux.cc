// Copyright 2026 Bay. Apache-2.0.

#include <string>

#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/nix/xdg_util.h"
#include "base/strings/escape.h"
#include "base/strings/stringprintf.h"
#include "base/time/time.h"
#include "chrome/browser/bay/webui/shared_folders.h"

namespace bay {

// The freedesktop.org Trash in the home folder: the file in Trash/files, and a
// Trash/info/<name>.trashinfo saying where it was and when it went.
bool MoveToTrash(const base::FilePath& path) {
  auto env = base::Environment::Create();
  const base::FilePath trash =
      base::nix::GetXDGDirectory(env.get(), "XDG_DATA_HOME", ".local/share")
          .AppendASCII("Trash");
  const base::FilePath files = trash.AppendASCII("files");
  const base::FilePath info = trash.AppendASCII("info");
  if (!base::CreateDirectory(files) || !base::CreateDirectory(info))
    return false;
  // A name not in the Trash yet: "Name.url", then "Name 2.url"…
  const base::FilePath name = path.BaseName();
  base::FilePath target;
  base::FilePath record;
  for (int n = 1; n < 1000 && target.empty(); ++n) {
    const base::FilePath candidate =
        n == 1 ? name
               : name.InsertBeforeExtensionASCII(base::StringPrintf(" %d", n));
    const base::FilePath record_path =
        info.Append(candidate.value() + ".trashinfo");
    if (!base::PathExists(files.Append(candidate)) &&
        !base::PathExists(record_path)) {
      target = files.Append(candidate);
      record = record_path;
    }
  }
  if (target.empty())
    return false;
  // The spec's local time, without a zone.
  base::Time::Exploded now;
  base::Time::Now().LocalExplode(&now);
  const std::string entry = base::StringPrintf(
      "[Trash Info]\nPath=%s\nDeletionDate=%04d-%02d-%02dT%02d:%02d:%02d\n",
      base::EscapePath(path.value()).c_str(), now.year, now.month,
      now.day_of_month, now.hour, now.minute, now.second);
  if (!base::WriteFile(record, entry))
    return false;
  // A rename: the home folder's Trash takes files on its own disk only.
  if (!base::Move(path, target) || base::PathExists(path)) {
    base::DeleteFile(record);
    return false;
  }
  return true;
}

}  // namespace bay
