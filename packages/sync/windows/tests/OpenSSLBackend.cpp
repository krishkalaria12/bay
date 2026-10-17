// Test-only crypto adapter. The shipped Windows application always uses CNG.
#include "../SyncCrypto.h"
#include <memory>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
namespace bay::sync {
Bytes randomBytes(std::size_t n) {
  Bytes out(n);
  if (RAND_bytes(out.data(), static_cast<int>(n)) != 1)
    throw Failure("crypto", "random");
  return out;
}
Bytes sha256(const Bytes &data) {
  Bytes out(32);
  unsigned n;
  EVP_Digest(data.data(), data.size(), out.data(), &n, EVP_sha256(), nullptr);
  return out;
}
Bytes hmac256(const Bytes &key, const Bytes &data) {
  Bytes out(32);
  unsigned n;
  HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()), data.data(),
       data.size(), out.data(), &n);
  return out;
}
Bytes aesGcmSeal(const Bytes &key, const Bytes &nonce, const Bytes &plain,
                 const Bytes &aad) {
  std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> ctx(
      EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
  Bytes out(plain.size() + 16);
  int n = 0, length = 0;
  EVP_EncryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(),
                     nonce.data());
  EVP_EncryptUpdate(ctx.get(), nullptr, &n, aad.data(),
                    static_cast<int>(aad.size()));
  EVP_EncryptUpdate(ctx.get(), out.data(), &length, plain.data(),
                    static_cast<int>(plain.size()));
  EVP_EncryptFinal_ex(ctx.get(), out.data() + length, &n);
  EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG, 16,
                      out.data() + plain.size());
  return out;
}
Bytes aesGcmOpen(const Bytes &key, const Bytes &nonce, const Bytes &input,
                 const Bytes &aad) {
  if (input.size() < 16)
    throw Failure("format", "short");
  std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> ctx(
      EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
  Bytes out(input.size() - 16);
  int n = 0, length = 0;
  EVP_DecryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(),
                     nonce.data());
  EVP_DecryptUpdate(ctx.get(), nullptr, &n, aad.data(),
                    static_cast<int>(aad.size()));
  EVP_DecryptUpdate(ctx.get(), out.data(), &length, input.data(),
                    static_cast<int>(out.size()));
  EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_TAG, 16,
                      const_cast<unsigned char *>(input.data() + out.size()));
  if (EVP_DecryptFinal_ex(ctx.get(), out.data() + length, &n) != 1)
    throw Failure("authentication", "authentication");
  return out;
}
} // namespace bay::sync
