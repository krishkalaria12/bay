#pragma once
#include <cstdint>
#include <filesystem>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace bay::sync {
using Bytes = std::vector<std::uint8_t>;
struct Failure : std::runtime_error {
  std::string code;
  Failure(std::string code, std::string message)
      : std::runtime_error(std::move(message)), code(std::move(code)) {}
};
Bytes randomBytes(std::size_t count);
Bytes sha256(const Bytes &data);
Bytes hmac256(const Bytes &key, const Bytes &data);
Bytes aesGcmSeal(const Bytes &key, const Bytes &nonce, const Bytes &plain,
                 const Bytes &aad);
Bytes aesGcmOpen(const Bytes &key, const Bytes &nonce,
                 const Bytes &cipherAndTag, const Bytes &aad);
std::string base32(const Bytes &bytes);
bool isTag(const std::string &text);
class Keys {
public:
  explicit Keys(const Bytes &entropy);
  ~Keys();
  std::string chainTag() const;
  std::string scopeTag(const std::string &scope) const;
  Bytes seal(const Bytes &payload, const std::string &scope,
             const std::string &file) const;
  // Explicit nonce is for cross-platform vectors only. Production callers
  // always use seal().
  Bytes sealWithNonce(const Bytes &payload, const std::string &scope,
                      const std::string &file, const Bytes &nonce) const;
  Bytes open(const Bytes &file, const std::string &scope,
             const std::string &id) const;

private:
  Bytes fileKey_, nameKey_;
  std::string tag(const std::string &label) const;
  Bytes aad(const std::string &scope, const std::string &id) const;
};
std::vector<std::string> recoveryWords(const Bytes &entropy);
Bytes recoveryEntropy(const std::string &phrase);
void erase(Bytes &bytes) noexcept;
// DPAPI is user-bound and intentionally never uses CRYPTPROTECT_LOCAL_MACHINE.
Bytes protect(const Bytes &plain);
Bytes unprotect(const Bytes &sealed);
bool saveSecret(const std::string &account, const Bytes &secret);
std::optional<Bytes> loadSecret(const std::string &account);
void deleteSecret(const std::string &account);
} // namespace bay::sync
