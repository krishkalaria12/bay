// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/default_browser.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/memory/scoped_refptr.h"

namespace bay {
namespace {
void RunOperation(bool set_as_default,
                  shell_integration::DefaultWebClientWorkerCallback done) {
  auto worker = base::MakeRefCounted<shell_integration::DefaultBrowserWorker>();
  if (set_as_default)
    worker->StartSetAsDefault(std::move(done));
  else
    worker->StartCheckIsDefault(std::move(done));
}
}  // namespace

DefaultBrowser::DefaultBrowser(HostContext context)
    : DefaultBrowser(std::move(context), {}) {}
DefaultBrowser::DefaultBrowser(HostContext context, Operation operation)
    : operation_(operation ? std::move(operation)
                           : base::BindRepeating(&RunOperation)) {}
DefaultBrowser::~DefaultBrowser() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
  auto pending = std::move(pending_);
  const auto response =
      base::WriteJson(
          base::DictValue().Set(
              "error",
              base::DictValue()
                  .Set("code", "host_closed")
                  .Set("message", "The default browser service was closed")))
          .value_or("{}");
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
  auto done = base::BindOnce(&DefaultBrowser::Complete,
                             weak_factory_.GetWeakPtr(), request);
  // A fake operation or synchronous completion may destroy this owner. Keep
  // the callable alive and do not access members after invoking it.
  auto operation = operation_;
  operation.Run(method == "setAsDefaultBrowser", std::move(done));
  return true;
}

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
