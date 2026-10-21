// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHELL_UI_H_
#define CHROME_BROWSER_BAY_WEBUI_SHELL_UI_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/shell_ui_options.h"

namespace gfx {
class Image;
}
namespace bay {
class HostContext;

// UI-sequence owner for native shell dialogs and icon requests. Destroying the
// owning NativeHost dismisses its prompts and settles each callback once.
class ShellUI {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  ShellUI();
  ~ShellUI();
  ShellUI(const ShellUI&) = delete;
  ShellUI& operator=(const ShellUI&) = delete;
  // False leaves callback untouched. The only handled methods are
  // BayShell.prompt and BaySystem.fileIcon, with normal native wire envelopes.
  bool Dispatch(const HostContext& context,
                const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  struct PendingPrompt;
  struct PendingIcon;
  void PromptFinished(uint64_t token, std::optional<std::string> text);
  void IconLoaded(uint64_t token, int pixels, const gfx::Image& image);
  void IconFinished(uint64_t token, std::optional<std::string> image);

  uint64_t next_token_ = 1;
  std::map<uint64_t, std::unique_ptr<PendingPrompt>> prompts_;
  std::map<uint64_t, std::unique_ptr<PendingIcon>> icons_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<ShellUI> weak_factory_{this};
};
}  // namespace bay
#endif
