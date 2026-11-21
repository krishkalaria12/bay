#include "../windows/SyncCrypto.h"
#include <algorithm>
#include <cerrno>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <sys/stat.h>

namespace bay::sync {
namespace {
void check(int result) {
  if (result != 1)
    throw Failure("crypto", "Linux cryptography operation failed");
}
int length(std::size_t n) {
  if (n > static_cast<std::size_t>(std::numeric_limits<int>::max()))
    throw Failure("format", "Input is too large");
  return static_cast<int>(n);
}
Bytes crypt(bool seal, const Bytes &key, const Bytes &nonce, const Bytes &input,
            const Bytes &aad) {
  if (key.size() != 32 || nonce.size() != 12 || (!seal && input.size() < 16))
    throw Failure("format", "Invalid AES-GCM input");
  const auto bodyLength = seal ? input.size() : input.size() - 16;
  const auto bodySize = length(bodyLength);
  const auto aadSize = length(aad.size());
  std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> ctx(
      EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
  if (!ctx)
    throw Failure("crypto", "Could not allocate AES-GCM context");
  Bytes output(bodyLength + 16);
  try {
    check(EVP_CipherInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(),
                            nonce.data(), seal ? 1 : 0));
    int count = 0, written = 0;
    check(EVP_CipherUpdate(ctx.get(), nullptr, &count, aad.data(), aadSize));
    check(EVP_CipherUpdate(ctx.get(), output.data(), &written, input.data(),
                           bodySize));
    if (!seal)
      check(EVP_CIPHER_CTX_ctrl(
          ctx.get(), EVP_CTRL_GCM_SET_TAG, 16,
          const_cast<std::uint8_t *>(input.data() + bodyLength)));
    if (EVP_CipherFinal_ex(ctx.get(), output.data() + written, &count) != 1)
      throw Failure(seal ? "crypto" : "authentication",
                    "AES-GCM authentication failed");
    if (seal)
      check(EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG, 16,
                                output.data() + bodyLength));
    output.resize(bodyLength + (seal ? 16 : 0));
    return output;
  } catch (...) {
    erase(output);
    throw;
  }
}
const Bytes &wrappingKey() {
  struct Key {
    Bytes value;
    Key() {
      constexpr auto account = "local-vault-wrapping-key";
      auto stored = loadSecret(account);
      if (stored) {
        if (stored->size() != 32) {
          erase(*stored);
          throw Failure("keychain", "Invalid local wrapping key");
        }
        value = std::move(*stored);
      } else {
        value = randomBytes(32);
        // Without Secret Service this key lives only for this process.
        saveSecret(account, value);
      }
    }
    ~Key() { erase(value); }
  };
  static std::mutex mutex;
  static std::map<std::string, Key> keys;
  const auto name = GetSecretNamespace();
  std::lock_guard<std::mutex> lock(mutex);
  return keys.try_emplace(name).first->second.value;
}
} // namespace
Bytes randomBytes(std::size_t count) {
  Bytes out(count);
  check(RAND_bytes(out.data(), length(count)));
  return out;
}
Bytes sha256(const Bytes &data) {
  Bytes out(32);
  unsigned count = 0;
  check(EVP_Digest(data.data(), data.size(), out.data(), &count, EVP_sha256(),
                   nullptr));
  return out;
}
Bytes hmac256(const Bytes &key, const Bytes &data) {
  Bytes out(32);
  unsigned count = 0;
  if (!HMAC(EVP_sha256(), key.data(), length(key.size()), data.data(),
            data.size(), out.data(), &count))
    throw Failure("crypto", "Could not calculate HMAC");
  return out;
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
  auto nonce = randomBytes(12);
  auto sealed =
      aesGcmSeal(wrappingKey(), nonce, plain, Bytes{'B', 'L', 'K', '1'});
  Bytes out{'B', 'L', 'K', '1'};
  out.insert(out.end(), nonce.begin(), nonce.end());
  out.insert(out.end(), sealed.begin(), sealed.end());
  return out;
}
Bytes unprotect(const Bytes &sealed) {
  if (sealed.size() < 32 ||
      !std::equal(sealed.begin(), sealed.begin() + 4, "BLK1"))
    throw Failure("locked", "Invalid local secret envelope");
  return aesGcmOpen(
      wrappingKey(), Bytes(sealed.begin() + 4, sealed.begin() + 16),
      Bytes(sealed.begin() + 16, sealed.end()), Bytes{'B', 'L', 'K', '1'});
}
void createPrivateDirectory(const std::filesystem::path &path) {
  // Set owner-only permissions at creation, before any secret can enter it.
  if (::mkdir(path.c_str(), 0700) != 0)
    throw Failure("folder", "Could not create a private folder");
}
} // namespace bay::sync
