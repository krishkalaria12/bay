// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/secret_storage_linux.h"

#include <optional>
#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "chrome/browser/browser_process.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/async/common/encryptor.h"

namespace bay {
namespace {

// PosixKeyProvider's tag. Every other Linux provider (v11 Secret Service and
// KWallet, v12 Secret portal) keeps its key in the desktop's secret store.
constexpr std::string_view kBasicTag = "v10";

std::string Success(std::string_view kind) {
  return base::WriteJson(base::DictValue().Set("value", kind))
      .value_or("{}");
}
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}

}  // namespace

std::string_view SecretStorageKind(const os_crypt_async::Encryptor& encryptor) {
  if (!encryptor.IsEncryptionAvailable())
    return "unavailable";
  // The encryptor doesn't name its provider, but its ciphertext starts with
  // the provider's tag.
  std::string ciphertext;
  if (!encryptor.EncryptString("bay", &ciphertext))
    return "unavailable";
  return ciphertext.starts_with(kBasicTag) ? "basic" : "keyring";
}

SecretStorage::SecretStorage() = default;
SecretStorage::~SecretStorage() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
  for (auto& callback : std::exchange(pending_, {}))
    std::move(callback).Run(Failure(
        "host_closed", "The document closed before the keyring answered"));
}

// static
base::ListValue SecretStorage::SupportedMethods() {
  return base::ListValue().Append("BayCEF.secretStorage");
}

bool SecretStorage::Dispatch(const std::string& module,
                             const std::string& method,
                             const base::ListValue& args,
                             Response& callback) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (module != "BayCEF" || method != "secretStorage")
    return false;
  if (!args.empty()) {
    std::move(callback).Run(
        Failure("invalid_args", "secretStorage takes no arguments"));
    return true;
  }
  pending_.push_back(std::move(callback));
  if (pending_.size() == 1) {
    // May answer before returning when the encryptor is already ready.
    g_browser_process->os_crypt_async()->GetInstance(
        base::BindOnce(&SecretStorage::Resolved, weak_factory_.GetWeakPtr()));
  }
  return true;
}

void SecretStorage::Resolved(
    scoped_refptr<os_crypt_async::Encryptor> encryptor) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const std::string response =
      Success(encryptor ? SecretStorageKind(*encryptor) : "unavailable");
  for (auto& callback : std::exchange(pending_, {}))
    std::move(callback).Run(response);
}

}  // namespace bay
