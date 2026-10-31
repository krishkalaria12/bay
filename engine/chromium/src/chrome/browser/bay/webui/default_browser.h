// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DEFAULT_BROWSER_H_
#define CHROME_BROWSER_BAY_WEBUI_DEFAULT_BROWSER_H_

#include <cstdint>
#include <map>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/shell_integration.h"

namespace bay {
// Document-owned UI-sequence service. The caller owns profile, readiness and
// contract-arity checks, including Windows' initialization-error gate. Browser
// registration is process-wide; no profile is passed to the worker.
class DefaultBrowser final {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  // External-effect seam: true requests setting the default, false checks it.
  // Called on UI, with completion on UI, synchronously or later. An empty
  // operation selects Chromium's DefaultBrowserWorker on Windows and Linux.
  using Operation = base::RepeatingCallback<
      void(bool, shell_integration::DefaultWebClientWorkerCallback)>;
#if BUILDFLAG(IS_LINUX)
  // Answers whether Bay's desktop entry is in an XDG applications directory;
  // xdg-settings can't make Bay the default without it. Called on UI, with
  // completion on UI, synchronously or later. An empty probe searches the
  // XDG data directories on a worker.
  using DesktopEntryProbe =
      base::RepeatingCallback<void(base::OnceCallback<void(bool)>)>;
#endif

  explicit DefaultBrowser(HostContext context);
  DefaultBrowser(HostContext context, Operation operation);
#if BUILDFLAG(IS_LINUX)
  DefaultBrowser(HostContext context,
                 Operation operation,
                 DesktopEntryProbe probe);
#endif
  ~DefaultBrowser();
  DefaultBrowser(const DefaultBrowser&) = delete;
  DefaultBrowser& operator=(const DefaultBrowser&) = delete;

  static base::ListValue SupportedMethods();
  // Unhandled methods leave callback untouched. Accepted requests settle once,
  // including teardown. Already-started OS work may outlive the document.
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  void Run(uint64_t request, bool set_as_default);
#if BUILDFLAG(IS_LINUX)
  void SetIfDesktopEntry(uint64_t request, bool installed);
#endif
  void Complete(uint64_t request,
                shell_integration::DefaultWebClientState state);

  Operation operation_;
#if BUILDFLAG(IS_LINUX)
  DesktopEntryProbe probe_;
#endif
  uint64_t next_request_ = 0;
  std::map<uint64_t, Response> pending_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<DefaultBrowser> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_DEFAULT_BROWSER_H_
