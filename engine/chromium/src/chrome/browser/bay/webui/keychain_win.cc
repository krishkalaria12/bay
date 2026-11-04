// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/keychain.h"

#include <windows.h>

#include <wincred.h>

#include <utility>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_writer.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"

namespace bay {
namespace {
std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
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

std::string Keychain::Credential(const std::string& method,
                                 const std::string& account,
                                 std::string secret) {
  base::ScopedClosureRunner wipe(base::BindOnce(
      [](std::string* value) {
        SecureZeroMemory(value->data(), value->size());
      },
      &secret));
  if (account.empty() || !base::IsStringUTF8(account) ||
      account.find('\0') != std::string::npos)
    return Failure("invalid_args", "Credential account is invalid");
  const std::wstring target = L"Bay:" + base::UTF8ToWide(account);
  if (target.size() > CRED_MAX_GENERIC_TARGET_NAME_LENGTH)
    return Failure("invalid_args", "Credential account is too long");
  if (method == "get") {
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &credential)) {
      return GetLastError() == ERROR_NOT_FOUND
                 ? Success()
                 : Failure("credential_error",
                           "Windows could not read this credential");
    }
    std::string value(reinterpret_cast<char*>(credential->CredentialBlob),
                      credential->CredentialBlobSize);
    SecureZeroMemory(credential->CredentialBlob,
                     credential->CredentialBlobSize);
    CredFree(credential);
    if (!base::IsStringUTF8(value)) {
      SecureZeroMemory(value.data(), value.size());
      return Failure("credential_error", "The saved credential is invalid");
    }
    return Success(base::Value(std::move(value)));
  }
  if (method == "delete") {
    const bool deleted = CredDeleteW(target.c_str(), CRED_TYPE_GENERIC, 0);
    return Success(base::Value(deleted || GetLastError() == ERROR_NOT_FOUND));
  }
  if (secret.size() > CRED_MAX_CREDENTIAL_BLOB_SIZE)
    return Failure("invalid_args", "Credential exceeds the Windows size limit");
  CREDENTIALW credential{};
  credential.Type = CRED_TYPE_GENERIC;
  credential.TargetName = const_cast<wchar_t*>(target.c_str());
  credential.CredentialBlobSize = static_cast<DWORD>(secret.size());
  credential.CredentialBlob =
      reinterpret_cast<BYTE*>(const_cast<char*>(secret.data()));
  credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
  const bool saved = CredWriteW(&credential, 0) != FALSE;
  return Success(base::Value(saved));
}
}  // namespace bay
