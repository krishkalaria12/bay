#include "../windows/SyncCrypto.h"
#include <cstdlib>
#include <libsecret/secret.h>
#include <mutex>

namespace bay::sync {
namespace {
std::mutex namespaceMutex;
std::string secretNamespace;
const SecretSchema schema = {"app.bay.SyncKey",
                             SECRET_SCHEMA_NONE,
                             {{"account", SECRET_SCHEMA_ATTRIBUTE_STRING},
                              {"profile", SECRET_SCHEMA_ATTRIBUTE_STRING},
                              {nullptr, SECRET_SCHEMA_ATTRIBUTE_STRING}},
                             0,
                             nullptr,
                             nullptr,
                             nullptr,
                             nullptr,
                             nullptr,
                             nullptr,
                             nullptr};
std::string profile() {
  std::lock_guard<std::mutex> lock(namespaceMutex);
  if (!secretNamespace.empty())
    return secretNamespace;
  const auto *custom = std::getenv("BAY_DATA_DIR");
  return custom ? custom : "default";
}
struct Password {
  gchar *value;
  ~Password() {
    if (value)
      secret_password_free(value);
  }
};
} // namespace
void SetSecretNamespace(std::string directory) {
  std::lock_guard<std::mutex> lock(namespaceMutex);
  secretNamespace = std::move(directory);
}
std::string GetSecretNamespace() { return profile(); }
bool saveSecret(const std::string &account, const Bytes &secret) {
  if (secret.size() != 32)
    return false;
  static constexpr char hex[] = "0123456789abcdef";
  std::string encoded;
  encoded.reserve(secret.size() * 2);
  for (auto byte : secret) {
    encoded += hex[byte >> 4];
    encoded += hex[byte & 15];
  }
  GError *error = nullptr;
  bool saved = secret_password_store_sync(
      &schema, SECRET_COLLECTION_DEFAULT, "Bay Sync Key", encoded.c_str(),
      nullptr, &error, "account", account.c_str(), "profile", profile().c_str(),
      nullptr);
  volatile char *data = encoded.data();
  for (std::size_t i = 0; i < encoded.size(); ++i)
    data[i] = 0;
  if (error)
    g_error_free(error);
  return saved;
}
std::optional<Bytes> loadSecret(const std::string &account) {
  GError *error = nullptr;
  Password password{secret_password_lookup_sync(
      &schema, nullptr, &error, "account", account.c_str(), "profile",
      profile().c_str(), nullptr)};
  if (error)
    g_error_free(error);
  if (!password.value || std::char_traits<char>::length(password.value) != 64)
    return std::nullopt;
  Bytes value;
  value.reserve(32);
  int high = -1;
  for (const char *p = password.value; *p; ++p) {
    int digit = *p >= '0' && *p <= '9'   ? *p - '0'
                : *p >= 'a' && *p <= 'f' ? *p - 'a' + 10
                                         : -1;
    if (digit < 0) {
      erase(value);
      return std::nullopt;
    }
    if (high < 0)
      high = digit;
    else {
      value.push_back(static_cast<std::uint8_t>((high << 4) | digit));
      high = -1;
    }
  }
  return value;
}
void deleteSecret(const std::string &account) {
  GError *error = nullptr;
  bool removed = secret_password_clear_sync(&schema, nullptr, &error, "account",
                                            account.c_str(), "profile",
                                            profile().c_str(), nullptr);
  if (error) {
    g_error_free(error);
    // A failed delete must not look like a successful revocation.
    throw Failure("keychain",
                  "Could not remove the sync key from Secret Service");
  }
  (void)removed; // No matching item is already forgotten.
}
} // namespace bay::sync
