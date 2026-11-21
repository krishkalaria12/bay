// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_NATIVE_FILE_DRAG_H_
#define CHROME_BROWSER_BAY_WEBUI_NATIVE_FILE_DRAG_H_

#include <memory>
#include <optional>
#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"

namespace content {
class WebContents;
}
namespace ui {
class OSExchangeData;
}
namespace bay {
class LocalFileGrants;

// Outgoing files use Chromium's desktop drag client, which supplies real OLE,
// XDND or Wayland file data rather than renderer-authored file URLs.
class NativeFileDrag {
 public:
  struct Result {
    bool started = false;
    std::string operation = "none";
    // Cancellation, including mouse release while resolving, is not an error.
    std::string error;
  };
  using Callback = base::OnceCallback<void(Result)>;

  // Caller must have authenticated this as its HostContext window document.
  // A relative value, including "", always requires a pinned-file grant.
  // Without one, path is a download's absolute local path. Requires an actual
  // held left-mouse gesture; async disk work cannot start a drag after release.
  static void Start(content::WebContents* document,
                    const std::string& path,
                    const std::optional<std::string>& relative,
                    Callback callback);

  // Disk-only resolution, shared by the start path and its authority tests.
  static std::optional<base::FilePath> ResolvePath(
      const std::string& path,
      const std::optional<std::string>& relative,
      LocalFileGrants& grants);
  static std::unique_ptr<ui::OSExchangeData> CreateData(
      const base::FilePath& path);
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_NATIVE_FILE_DRAG_H_
