#include "SyncCrypto.h"
#include "Wordlist.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <limits>
#ifdef _WIN32
// First: bcrypt, wincred and wincrypt use its types.
#include <windows.h>
#include <bcrypt.h>
#include <wincred.h>
#include <wincrypt.h>
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "advapi32.lib")
#endif

namespace bay::sync {
namespace {
Bytes bytes(const std::string &text) { return Bytes(text.begin(), text.end()); }
Bytes hkdf(const Bytes &entropy, const std::string &info) {
  auto prk = hmac256(bytes("bay-sync/v1"), entropy);
  auto label = bytes(info);
  label.push_back(1);
  auto out = hmac256(prk, label);
  erase(prk);
  return out;
}
#ifdef _WIN32
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
#endif
} // namespace
void erase(Bytes &data) noexcept {
  volatile std::uint8_t *p = data.data();
  for (std::size_t i = 0; i < data.size(); ++i)
    p[i] = 0;
  data.clear();
}
#ifdef _WIN32
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
#endif
std::string base32(const Bytes &input) {
  static constexpr char alphabet[] = "abcdefghijklmnopqrstuvwxyz234567";
  std::string result;
  unsigned buffer = 0, bits = 0;
  for (auto byte : input) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >> bits) & 31];
    }
    buffer &= (1u << bits) - 1;
  }
  if (bits)
    result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}
bool isTag(const std::string &text) {
  return text.size() == 26 &&
         text.find_first_not_of("abcdefghijklmnopqrstuvwxyz234567") ==
             std::string::npos;
}
Keys::Keys(const Bytes &entropy) {
  if (entropy.size() != 32)
    throw Failure("format", "Recovery entropy must contain 32 bytes");
  fileKey_ = hkdf(entropy, "file-key");
  nameKey_ = hkdf(entropy, "name-key");
}
Keys::~Keys() {
  erase(fileKey_);
  erase(nameKey_);
}
std::string Keys::tag(const std::string &label) const {
  auto hash = hmac256(nameKey_, bytes(label));
  hash.resize(16);
  return base32(hash);
}
std::string Keys::chainTag() const { return tag("chain"); }
std::string Keys::scopeTag(const std::string &scope) const {
  return tag("scope/" + scope);
}
Bytes Keys::aad(const std::string &scope, const std::string &id) const {
  return bytes("NNS1" + chainTag() + "/" + scope + "/" + id);
}
Bytes Keys::seal(const Bytes &payload, const std::string &scope,
                 const std::string &id) const {
  return sealWithNonce(payload, scope, id, randomBytes(12));
}
Bytes Keys::sealWithNonce(const Bytes &payload, const std::string &scope,
                          const std::string &id, const Bytes &nonce) const {
  if (payload.size() > std::numeric_limits<std::uint32_t>::max())
    throw Failure("format", "Sync payload is too large");
  auto n = static_cast<std::uint32_t>(payload.size());
  Bytes plain{static_cast<std::uint8_t>(n >> 24),
              static_cast<std::uint8_t>(n >> 16),
              static_cast<std::uint8_t>(n >> 8), static_cast<std::uint8_t>(n)};
  plain.insert(plain.end(), payload.begin(), payload.end());
  plain.resize((plain.size() + 1023) / 1024 * 1024);
  Bytes encrypted;
  try {
    encrypted = aesGcmSeal(fileKey_, nonce, plain, aad(scope, id));
  } catch (...) {
    erase(plain);
    throw;
  }
  erase(plain);
  auto out = bytes("NNS1");
  out.insert(out.end(), nonce.begin(), nonce.end());
  out.insert(out.end(), encrypted.begin(), encrypted.end());
  return out;
}
Bytes Keys::open(const Bytes &file, const std::string &scope,
                 const std::string &id) const {
  if (file.size() < 36 || !std::equal(file.begin(), file.begin() + 4, "NNS1"))
    throw Failure("format", "Invalid sync envelope");
  auto plain = aesGcmOpen(fileKey_, Bytes(file.begin() + 4, file.begin() + 16),
                          Bytes(file.begin() + 16, file.end()), aad(scope, id));
  if (plain.size() < 4) {
    erase(plain);
    throw Failure("format", "Invalid sync payload length");
  }
  std::uint32_t n = 0;
  for (unsigned i = 0; i < 4; ++i)
    n = (n << 8) | plain[i];
  if (n > plain.size() - 4) {
    erase(plain);
    throw Failure("format", "Invalid sync payload length");
  }
  Bytes result(plain.begin() + 4, plain.begin() + 4 + n);
  erase(plain);
  return result;
}
std::vector<std::string> recoveryWords(const Bytes &entropy) {
  if (entropy.size() != 32)
    throw Failure("format", "Recovery entropy must contain 32 bytes");
  auto bits = entropy;
  bits.push_back(sha256(entropy).front());
  std::vector<std::string> words;
  for (unsigned start = 0; start < 264; start += 11) {
    unsigned value = 0;
    for (unsigned j = 0; j < 11; ++j)
      value =
          (value << 1) | ((bits[(start + j) / 8] >> (7 - (start + j) % 8)) & 1);
    words.emplace_back(wordlist[value]);
  }
  erase(bits);
  return words;
}
Bytes recoveryEntropy(const std::string &phrase) {
  std::vector<std::string> tokens;
  std::string token;
  for (unsigned char c : phrase) {
    if (std::isalpha(c) && c < 128)
      token += static_cast<char>(std::tolower(c));
    else if (!token.empty()) {
      tokens.push_back(token);
      token.clear();
    }
  }
  if (!token.empty())
    tokens.push_back(token);
  if (tokens.size() != 24)
    throw Failure("wordCount", std::to_string(tokens.size()));
  Bytes combined(33);
  unsigned bit = 0;
  for (const auto &word : tokens) {
    int index = -1;
    for (unsigned i = 0; i < 2048; ++i) {
      std::string candidate(wordlist[i]);
      if (candidate == word ||
          (word.size() >= 4 && candidate.compare(0, word.size(), word) == 0)) {
        index = static_cast<int>(i);
        break;
      }
    }
    if (index < 0) {
      erase(combined);
      throw Failure("unknownWord", word);
    }
    for (int j = 10; j >= 0; --j, ++bit)
      combined[bit / 8] |= ((index >> j) & 1) << (7 - bit % 8);
  }
  Bytes entropy(combined.begin(), combined.begin() + 32);
  if (sha256(entropy).front() != combined.back()) {
    erase(entropy);
    erase(combined);
    throw Failure("checksum", "Recovery phrase checksum does not match");
  }
  erase(combined);
  return entropy;
}
} // namespace bay::sync
