// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHELL_UI_H_
#define CHROME_BROWSER_BAY_WEBUI_SHELL_UI_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/shell_ui_options.h"

namespace gfx {
class Image;
}
namespace views {
class DialogDelegate;
}
namespace bay {
class HostContext;

// UI-sequence owner for native shell dialogs and icon requests. Destroying the
// owning NativeHost dismisses prompts and settles each callback once. File
// picker detachment waits for the native callback stack to unwind.
class ShellUI {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  ShellUI();
  ~ShellUI();
  ShellUI(const ShellUI&) = delete;
  ShellUI& operator=(const ShellUI&) = delete;
  // False leaves callback untouched. The only handled methods are
  // BayShell.prompt, BayShell.confirm, BayShell.pickFiles and
  // BaySystem.fileIcon, with normal native wire envelopes.
  bool Dispatch(const HostContext& context,
                const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  class FilePicker;
  struct PendingDialog;
  struct PendingIcon;
  // A dialog answers once with its wire response.
  using DialogCompletion = base::OnceCallback<void(std::string)>;
  using DialogFactory =
      base::OnceCallback<std::unique_ptr<views::DialogDelegate>(
          DialogCompletion)>;
  // Shows a window-modal dialog in `window_id`, or the caller's own window.
  // `cancelled` answers if the document goes away first.
  void ShowDialog(const HostContext& context,
                  const std::optional<std::string>& window_id,
                  std::string cancelled,
                  Response& callback,
                  DialogFactory create);
  void FilePickerFinished(FilePicker* picker);
  void DialogFinished(uint64_t token, std::string response);
  void IconLoaded(uint64_t token, int pixels, const gfx::Image& image);
  void IconFinished(uint64_t token, std::optional<std::string> image);

  uint64_t next_token_ = 1;
  scoped_refptr<FilePicker> file_picker_;
  std::map<uint64_t, std::unique_ptr<PendingDialog>> dialogs_;
  std::map<uint64_t, std::unique_ptr<PendingIcon>> icons_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<ShellUI> weak_factory_{this};
};
}  // namespace bay
#endif
