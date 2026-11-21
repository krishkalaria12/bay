#include "SyncCrypto.h"
#include <algorithm>
#include <limits>
// First: bcrypt, wincred and wincrypt use its types.
#include <windows.h>

#include <bcrypt.h>
#include <sddl.h>
#include <wincred.h>
#include <wincrypt.h>
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "advapi32.lib")

namespace bay::sync {
namespace {
Bytes bytes(const std::string &text) { return Bytes(text.begin(), text.end()); }
void check(NTSTATUS status) {
  if (status < 0)
    throw Failure("crypto", "Windows cryptography operation failed");
}
ULONG length(std::size_t n) {
  if (n > std::numeric_limits<ULONG>::max())
    throw Failure("format", "Input is too large");
  return static_cast<ULONG>(n);
}
struct Algorithm {
  BCRYPT_ALG_HANDLE value = nullptr;
  explicit Algorithm(LPCWSTR name, ULONG flags = 0) {
    check(BCryptOpenAlgorithmProvider(&value, name, nullptr, flags));
  }
  ~Algorithm() {
    if (value)
      BCryptCloseAlgorithmProvider(value, 0);
  }
};
Bytes digest(const Bytes &input, const Bytes *key) {
  Algorithm algorithm(BCRYPT_SHA256_ALGORITHM,
                      key ? BCRYPT_ALG_HANDLE_HMAC_FLAG : 0);
  Bytes result(32);
  check(BCryptHash(
      algorithm.value, key ? const_cast<PUCHAR>(key->data()) : nullptr,
      key ? length(key->size()) : 0, const_cast<PUCHAR>(input.data()),
      length(input.size()), result.data(), length(result.size())));
  return result;
}
Bytes crypt(bool seal, const Bytes &secret, const Bytes &nonce,
            const Bytes &input, const Bytes &aad) {
  if (secret.size() != 32 || nonce.size() != 12 || (!seal && input.size() < 16))
    throw Failure("format", "Invalid AES-GCM input");
  Algorithm algorithm(BCRYPT_AES_ALGORITHM);
  check(BCryptSetProperty(
      algorithm.value, BCRYPT_CHAINING_MODE,
      reinterpret_cast<PUCHAR>(const_cast<wchar_t *>(BCRYPT_CHAIN_MODE_GCM)),
      sizeof(BCRYPT_CHAIN_MODE_GCM), 0));
  BCRYPT_KEY_HANDLE handle = nullptr;
  check(BCryptGenerateSymmetricKey(algorithm.value, &handle, nullptr, 0,
                                   const_cast<PUCHAR>(secret.data()),
                                   length(secret.size()), 0));
  struct KeyCleanup {
    BCRYPT_KEY_HANDLE handle;
    ~KeyCleanup() { BCryptDestroyKey(handle); }
  } cleanup{handle};
  const auto bodyLength = seal ? input.size() : input.size() - 16;
  Bytes output(bodyLength), tag(16);
  if (!seal)
    std::copy(input.end() - 16, input.end(), tag.begin());
  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO auth;
  BCRYPT_INIT_AUTH_MODE_INFO(auth);
  auth.pbNonce = const_cast<PUCHAR>(nonce.data());
  auth.cbNonce = length(nonce.size());
  auth.pbAuthData = const_cast<PUCHAR>(aad.data());
  auth.cbAuthData = length(aad.size());
  auth.pbTag = tag.data();
  auth.cbTag = length(tag.size());
  ULONG written = 0;
  // CNG treats a null output pointer as a length query, including for an empty
  // message.
  std::uint8_t empty = 0;
  auto status = seal ? BCryptEncrypt(handle, const_cast<PUCHAR>(input.data()),
                                     length(bodyLength), &auth, nullptr, 0,
                                     output.empty() ? &empty : output.data(),
                                     length(output.size()), &written, 0)
                     : BCryptDecrypt(handle, const_cast<PUCHAR>(input.data()),
                                     length(bodyLength), &auth, nullptr, 0,
                                     output.empty() ? &empty : output.data(),
                                     length(output.size()), &written, 0);
  if (status < 0) {
    erase(output);
    throw Failure(seal ? "crypto" : "authentication",
                  "AES-GCM authentication failed");
  }
  output.resize(written);
  if (seal)
    output.insert(output.end(), tag.begin(), tag.end());
  return output;
}
std::wstring target(const std::string &account) {
  // Hashing account names gives a fixed, unambiguous Credential Manager target.
  wchar_t isolated[32768]{};
  const DWORD count = GetEnvironmentVariableW(L"BAY_DATA_DIR", isolated, 32768);
  std::string identity = account;
  if (count && count < 32768)
    identity += "\n" + std::filesystem::path(isolated).u8string();
  return L"Bay Sync Key/" +
         std::filesystem::u8path(base32(sha256(bytes(identity)))).wstring();
}
} // namespace
Bytes randomBytes(std::size_t count) {
  Bytes out(count);
  check(BCryptGenRandom(nullptr, out.data(), length(count),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG));
  return out;
}
Bytes sha256(const Bytes &data) { return digest(data, nullptr); }
Bytes hmac256(const Bytes &key, const Bytes &data) {
  return digest(data, &key);
}
Bytes aesGcmSeal(const Bytes &key, const Bytes &nonce, const Bytes &plain,
                 const Bytes &aad) {
  return crypt(true, key, nonce, plain, aad);
}
Bytes aesGcmOpen(const Bytes &key, const Bytes &nonce, const Bytes &cipher,
                 const Bytes &aad) {
  return crypt(false, key, nonce, cipher, aad);
}
Bytes protect(const Bytes &plain) {
  DATA_BLOB input{length(plain.size()), const_cast<BYTE *>(plain.data())},
      output{};
  if (!CryptProtectData(&input, L"Bay", nullptr, nullptr, nullptr,
                        CRYPTPROTECT_UI_FORBIDDEN, &output))
    throw Failure("keychain",
                  "Could not protect the secret for this Windows user");
  Bytes value(output.pbData, output.pbData + output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return value;
}
Bytes unprotect(const Bytes &sealed) {
  DATA_BLOB input{length(sealed.size()), const_cast<BYTE *>(sealed.data())},
      output{};
  if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &output))
    throw Failure("locked", "Windows could not unlock this secret");
  Bytes value(output.pbData, output.pbData + output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return value;
}
bool saveSecret(const std::string &account, const Bytes &secret) {
  auto name = target(account);
  CREDENTIALW credential{};
  credential.Type = CRED_TYPE_GENERIC;
  credential.TargetName = name.data();
  credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
  credential.CredentialBlob = const_cast<BYTE *>(secret.data());
  credential.CredentialBlobSize = length(secret.size());
  return CredWriteW(&credential, 0) != FALSE;
}
std::optional<Bytes> loadSecret(const std::string &account) {
  PCREDENTIALW credential = nullptr;
  if (!CredReadW(target(account).c_str(), CRED_TYPE_GENERIC, 0, &credential))
    return std::nullopt;
  Bytes result(credential->CredentialBlob,
               credential->CredentialBlob + credential->CredentialBlobSize);
  SecureZeroMemory(credential->CredentialBlob, credential->CredentialBlobSize);
  CredFree(credential);
  return result;
}
void deleteSecret(const std::string &account) {
  CredDeleteW(target(account).c_str(), CRED_TYPE_GENERIC, 0);
}
void createPrivateDirectory(const std::filesystem::path &path) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    throw Failure("folder", "Could not protect a private folder");
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  Bytes info(size);
  bool read =
      GetTokenInformation(token, TokenUser, info.data(), size, &size) != FALSE;
  CloseHandle(token);
  if (!read)
    throw Failure("folder", "Could not read the Windows user identity");
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(
          reinterpret_cast<TOKEN_USER *>(info.data())->User.Sid, &sid))
    throw Failure("folder", "Could not protect a private folder");
  std::wstring sddl =
      L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(sid) + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
    throw Failure("folder", "Could not protect a private folder");
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), descriptor,
                                 FALSE};
  bool created = CreateDirectoryW(path.c_str(), &attributes) != FALSE;
  LocalFree(descriptor);
  if (!created)
    throw Failure("folder", "Could not create a private folder");
}
} // namespace bay::sync
