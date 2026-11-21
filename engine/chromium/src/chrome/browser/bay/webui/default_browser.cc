// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/default_browser.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/memory/scoped_refptr.h"

#if BUILDFLAG(IS_LINUX)
#include <memory>

#include "base/environment.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/nix/xdg_util.h"
#include "base/task/thread_pool.h"
#include "chrome/common/channel_info.h"
#endif

namespace bay {
namespace {
std::string Error(const char* code, const std::string& message) {
  return base::WriteJson(base::DictValue().Set(
                             "error", base::DictValue()
                                          .Set("code", code)
                                          .Set("message", message)))
      .value_or("{}");
}

void RunOperation(bool set_as_default,
                  shell_integration::DefaultWebClientWorkerCallback done) {
  auto worker = base::MakeRefCounted<shell_integration::DefaultBrowserWorker>();
  if (set_as_default)
    worker->StartSetAsDefault(std::move(done));
  else
    worker->StartCheckIsDefault(std::move(done));
}

#if BUILDFLAG(IS_LINUX)
std::string DesktopEntryName() {
  auto env = base::Environment::Create();
  return chrome::GetDesktopName(env.get());
}

// The directories xdg-settings and desktops search for applications.
bool HasDesktopEntry() {
  const auto name = DesktopEntryName();
  auto env = base::Environment::Create();
  for (const auto& data : base::nix::GetXDGDataSearchLocations(env.get())) {
    if (base::PathExists(data.Append("applications").Append(name)))
      return true;
  }
  return false;
}

void ProbeDesktopEntry(base::OnceCallback<void(bool)> done) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&HasDesktopEntry), std::move(done));
}
#endif
}  // namespace

DefaultBrowser::DefaultBrowser(HostContext context)
    : DefaultBrowser(std::move(context), {}) {}
#if BUILDFLAG(IS_LINUX)
DefaultBrowser::DefaultBrowser(HostContext context, Operation operation)
    : DefaultBrowser(std::move(context), std::move(operation), {}) {}
DefaultBrowser::DefaultBrowser(HostContext context,
                               Operation operation,
                               DesktopEntryProbe probe)
    : operation_(operation ? std::move(operation)
                           : base::BindRepeating(&RunOperation)),
      probe_(probe ? std::move(probe)
                   : base::BindRepeating(&ProbeDesktopEntry)) {}
#else
DefaultBrowser::DefaultBrowser(HostContext context, Operation operation)
    : operation_(operation ? std::move(operation)
                           : base::BindRepeating(&RunOperation)) {}
#endif
DefaultBrowser::~DefaultBrowser() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
  auto pending = std::move(pending_);
  const auto response =
      Error("host_closed", "The default browser service was closed");
  for (auto& [request, callback] : pending)
    std::move(callback).Run(response);
}

// static
base::ListValue DefaultBrowser::SupportedMethods() {
  return base::ListValue()
      .Append("BaySystem.isDefaultBrowser")
      .Append("BaySystem.setAsDefaultBrowser");
}

bool DefaultBrowser::Dispatch(const std::string& module,
                              const std::string& method,
                              const base::ListValue& args,
                              Response& callback) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (module != "BaySystem" ||
      (method != "isDefaultBrowser" && method != "setAsDefaultBrowser"))
    return false;
  const auto request = next_request_++;
  pending_.emplace(request, std::move(callback));
  const bool set_as_default = method == "setAsDefaultBrowser";
#if BUILDFLAG(IS_LINUX)
  if (set_as_default) {
    // As with the operation below, a synchronous probe may destroy this owner.
    auto probe = probe_;
    probe.Run(base::BindOnce(&DefaultBrowser::SetIfDesktopEntry,
                             weak_factory_.GetWeakPtr(), request));
    return true;
  }
#endif
  Run(request, set_as_default);
  return true;
}

void DefaultBrowser::Run(uint64_t request, bool set_as_default) {
  auto done = base::BindOnce(&DefaultBrowser::Complete,
                             weak_factory_.GetWeakPtr(), request);
  // A fake operation or synchronous completion may destroy this owner. Keep
  // the callable alive and do not access members after invoking it.
  auto operation = operation_;
  operation.Run(set_as_default, std::move(done));
}

#if BUILDFLAG(IS_LINUX)
void DefaultBrowser::SetIfDesktopEntry(uint64_t request, bool installed) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (installed) {
    Run(request, true);
    return;
  }
  auto pending = pending_.extract(request);
  if (pending.empty())
    return;
  // Without the entry, xdg-settings fails and trying again can't help. Say
  // what is missing instead (an AppImage or archive run without integration).
  std::move(pending.mapped())
      .Run(Error("desktop_entry_missing",
                 "Bay can't be your default browser until " +
                     DesktopEntryName() +
                     " is in an applications folder, such as "
                     "~/.local/share/applications."));
}
#endif

void DefaultBrowser::Complete(uint64_t request,
                              shell_integration::DefaultWebClientState state) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  auto pending = pending_.extract(request);
  if (pending.empty())
    return;
  // Remove before responding: the response may reenter or destroy this owner.
  std::move(pending.mapped())
      .Run(base::WriteJson(base::DictValue().Set(
                               "value", state == shell_integration::IS_DEFAULT))
               .value_or("{}"));
}
}  // namespace bay
