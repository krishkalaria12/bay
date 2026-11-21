// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/keychain.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/strings/string_util.h"
#include "base/task/lazy_thread_pool_task_runner.h"
#include "base/task/sequenced_task_runner.h"

namespace bay {
namespace {
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}
// Order requests from replacement documents behind accepted writes. The lazy
// runner resets between test task environments. Unanswered unlock prompts must
// not hold up process exit.
base::LazyThreadPoolSequencedTaskRunner g_secret_runner =
    LAZY_THREAD_POOL_SEQUENCED_TASK_RUNNER_INITIALIZER(
        base::TaskTraits(base::MayBlock(),
                         base::TaskPriority::USER_VISIBLE,
                         base::TaskShutdownBehavior::CONTINUE_ON_SHUTDOWN));
}  // namespace

Keychain::Keychain(HostContext context, Operation operation)
    : context_(std::move(context)),
      operation_(operation ? std::move(operation)
                           : base::BindRepeating(&Keychain::Credential)) {}
Keychain::~Keychain() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
  auto pending = std::move(pending_);
  for (auto& [request, callback] : pending)
    std::move(callback).Run(
        Failure("host_closed", "The keychain service was closed"));
}
base::ListValue Keychain::SupportedMethods() {
  return base::ListValue()
      .Append("BayKeychain.get")
      .Append("BayKeychain.set")
      .Append("BayKeychain.delete");
}
bool Keychain::Dispatch(const std::string& module,
                        const std::string& method,
                        const base::ListValue& args,
                        Response& callback) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (module != "BayKeychain" ||
      (method != "get" && method != "set" && method != "delete"))
    return false;
  if (!context_.profile()) {
    std::move(callback).Run(Failure("profile_unavailable",
                                    "The host profile is no longer available"));
    return true;
  }
  const bool setter = method == "set";
  if (args.size() != (setter ? 2u : 1u) || !args[0].is_string() ||
      args[0].GetString().empty() ||
      args[0].GetString().find('\0') != std::string::npos ||
      !base::IsStringUTF8(args[0].GetString()) ||
      (setter &&
       (!args[1].is_string() || !base::IsStringUTF8(args[1].GetString())))) {
    std::move(callback).Run(
        Failure("invalid_args", "Invalid credential arguments"));
    return true;
  }
  const auto request = ++next_request_;
  pending_.emplace(request, std::move(callback));
  if (!g_secret_runner.Get()->PostTaskAndReplyWithResult(
          FROM_HERE,
          base::BindOnce(operation_, method, args[0].GetString(),
                         setter ? args[1].GetString() : std::string()),
          base::BindOnce(&Keychain::Complete, weak_factory_.GetWeakPtr(),
                         request)))
    Settle(request,
           Failure("credential_error", "The credential worker is unavailable"));
  return true;
}
void Keychain::Complete(uint64_t request, std::string response) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  Settle(request, context_.profile()
                      ? std::move(response)
                      : Failure("profile_unavailable",
                                "The host profile is no longer available"));
}
void Keychain::Settle(uint64_t request, std::string response) {
  auto found = pending_.find(request);
  if (found == pending_.end())
    return;
  auto callback = std::move(found->second);
  pending_.erase(found);
  std::move(callback).Run(response);
}
}  // namespace bay
