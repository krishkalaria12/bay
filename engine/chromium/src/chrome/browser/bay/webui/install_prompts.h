// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_INSTALL_PROMPTS_H_
#define CHROME_BROWSER_BAY_WEBUI_INSTALL_PROMPTS_H_

#include <map>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "chrome/browser/extensions/extension_install_prompt.h"

class Profile;
namespace content {
class WebContents;
}

namespace bay {

class NativeHost;

// Chrome's "Add <extension>?" (the Web Store, an extension asking for more
// permissions) on the web desktop host, as macOS nncore's
// HostExtensionInstallPrompt: Bay asks with its own UI
// (BayExtensions.onInstallPrompt) in one window, and Chrome waits for
// BayExtensions.resolveInstallPrompt. With no Bay window to ask in, Chrome's
// own dialog shows.
class InstallPrompts {
 public:
  // Sends the prompt to the window that should ask; nullptr when none can.
  using Sink = base::RepeatingCallback<base::WeakPtr<NativeHost>(
      content::WebContents* parent,
      base::DictValue prompt)>;

  static InstallPrompts& Get();

  InstallPrompts(const InstallPrompts&) = delete;
  InstallPrompts& operator=(const InstallPrompts&) = delete;

  // Takes Chrome's install prompts from now on. Later calls replace the sink.
  void Start(Sink sink);
  // The user's answer. Unknown or answered requests are ignored.
  void Resolve(const std::string& request_id, bool accepted);
  // A window that was asking went: its prompts are cancelled, as closing
  // Chrome's dialog would.
  void HostGone(const NativeHost* host);

  // The JS ExtensionInstallPrompt for |prompt|, with |request_id|.
  static base::DictValue Describe(const std::string& request_id,
                                  Profile* profile,
                                  int browser_id,
                                  const extensions::InstallPromptData& prompt);

 private:
  friend class base::NoDestructor<InstallPrompts>;
  struct Pending {
    Pending();
    Pending(Pending&&);
    Pending& operator=(Pending&&);
    ~Pending();
    ExtensionInstallPrompt::DoneCallback done;
    base::WeakPtr<Profile> profile;
    base::WeakPtr<NativeHost> host;
  };

  InstallPrompts();
  ~InstallPrompts();

  static bool Handle(Profile* profile,
                     content::WebContents* parent,
                     const extensions::InstallPromptData& prompt,
                     ExtensionInstallPrompt::DoneCallback* done_callback);
  void Finish(const std::string& request_id, bool accepted);

  Sink sink_;
  int last_id_ = 0;
  std::map<std::string, Pending> pending_;
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_INSTALL_PROMPTS_H_
