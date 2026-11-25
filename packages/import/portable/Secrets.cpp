#include "ImportCore.h"
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
#include "../linux/ChromiumSecrets.h"
#endif
#include <algorithm>
namespace bay::importer {
void wipeJson(Json &value) noexcept {
  if (value.is_string()) {
    auto &text = value.get_ref<std::string &>();
    volatile char *bytes = text.data();
    for (std::size_t i = 0; i < text.size(); ++i)
      bytes[i] = 0;
  } else if (value.is_array() || value.is_object())
    for (auto &child : value)
      wipeJson(child);
  value = nullptr;
}
namespace {
struct WipeSecretBytes {
  Bytes &bytes;
  ~WipeSecretBytes() { bay::sync::erase(bytes); }
};
Bytes decrypt(const Bytes &value, const Bytes &key) {
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
  // A legacy Bytes key cannot identify the Linux v11 scheme or source browser.
  // Keep old callers safe: fixed v10 only, without any desktop secret lookup.
  if (!key.empty())
    throw Failure("unsupported", "Use a source-specific Linux secret context");
  return decryptLinuxChromiumSecret(
      value, linuxChromiumSecrets(LinuxChromiumBrowser::Chromium));
#else
  if (value.size() >= 3 && value[0] == 'v' && value[1] == '2' &&
      value[2] == '0')
    throw Failure("appBound", "These secrets are protected by the source "
                              "browser. Export passwords as CSV");
  if (value.size() >= 3 && value[0] == 'v' && value[1] == '1' &&
      (value[2] == '0' || value[2] == '1')) {
    if (value.size() < 31 || key.size() != 32)
      throw Failure("locked", "Unlock the browser before importing passwords");
    return bay::sync::aesGcmOpen(key,
                                 Bytes(value.begin() + 3, value.begin() + 15),
                                 Bytes(value.begin() + 15, value.end()), {});
  }
#ifdef _WIN32
  return bay::sync::unprotect(value);
#else
  (void)key;
  throw Failure("unsupported", "DPAPI decryption requires Windows");
#endif
#endif
}
Bytes decrypt(const Bytes &value, const ChromiumSecretContext &context) {
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
  return decryptLinuxChromiumSecret(value, context);
#else
  (void)value;
  (void)context;
  throw Failure("unsupported", "Linux browser secret context requires Linux");
#endif
}
Bytes decrypt(const Bytes &value, const EnginePasswordDecryptor &decryptor) {
  auto plain = decryptor(std::string(value.begin(), value.end()));
  if (!plain)
    throw Failure("locked", "The browser could not decrypt a saved password");
  Bytes result(plain->begin(), plain->end());
  volatile char *bytes = plain->data();
  for (std::size_t i = 0; i < plain->size(); ++i)
    bytes[i] = 0;
  return result;
}
} // namespace
std::string encodeBase64(const Bytes &bytes) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (std::size_t i = 0; i < bytes.size(); i += 3) {
    std::uint32_t n = std::uint32_t(bytes[i]) << 16;
    if (i + 1 < bytes.size())
      n |= std::uint32_t(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size())
      n |= bytes[i + 2];
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += i + 1 < bytes.size() ? alphabet[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? alphabet[n & 63] : '=';
  }
  return out;
}
Bytes decodeBase64(const std::string &text) {
  static const std::string alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  Bytes out;
  unsigned buffer = 0, bits = 0;
  bool ended = false;
  for (unsigned char c : text) {
    if (c == ' ' || c == '\r' || c == '\n' || c == '\t')
      continue;
    if (c == '=') {
      ended = true;
      continue;
    }
    auto index = alphabet.find(static_cast<char>(c));
    if (index == std::string::npos || ended)
      throw Failure("format", "Invalid base64");
    buffer = (buffer << 6) | static_cast<unsigned>(index);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>(buffer >> bits));
      buffer &= (1u << bits) - 1;
    }
  }
  if (bits >= 6 || buffer != 0)
    throw Failure("format", "Invalid base64 padding");
  return out;
}
Bytes chromiumKey(const Path &root) {
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
  (void)root;
  return {}; // Legacy callers can read v10 only; no Local State or keyring
             // read.
#else
  auto data = Json::parse(readText(root / "Local State"));
  auto encrypted = decodeBase64(
      data.value("os_crypt", Json::object()).value("encrypted_key", ""));
  if (encrypted.size() < 5 ||
      !std::equal(encrypted.begin(), encrypted.begin() + 5, "DPAPI"))
    throw Failure(
        "appBound",
        "The browser does not expose a DPAPI key. Export passwords as CSV");
#ifdef _WIN32
  auto key =
      bay::sync::unprotect(Bytes(encrypted.begin() + 5, encrypted.end()));
  if (key.size() != 32) {
    bay::sync::erase(key);
    throw Failure("locked", "The browser key has an unexpected length");
  }
  return key;
#else
  throw Failure("unsupported", "DPAPI decryption requires Windows");
#endif
#endif
}
// This host's decryption of a sealed value, for the shared readers: a value it
// can't open is the reader's to count.
template <class Key> SecretOpener opener(const Key &key) {
  return [&key](const Bytes &sealed) -> std::optional<Bytes> {
    try {
      return decrypt(sealed, key);
    } catch (const Failure &) {
      return std::nullopt;
    }
  };
}
template <class Key>
Json chromiumLoginsImpl(const Path &profile, const Key &key,
                        const std::atomic_bool &cancelled, int &blocked) {
  auto answer = readSealed("chromiumLogins", profile, cancelled, opener(key));
  blocked = answer.value("blocked", 0);
  return std::move(answer["credentials"]);
}
Json chromiumLogins(const Path &profile, const Bytes &key,
                    const std::atomic_bool &cancelled, int &blocked) {
  return chromiumLoginsImpl(profile, key, cancelled, blocked);
}
Json chromiumLogins(const Path &profile, const ChromiumSecretContext &context,
                    const std::atomic_bool &cancelled, int &blocked) {
  return chromiumLoginsImpl(profile, context, cancelled, blocked);
}
template <class Key> Json enginePasswords(const Path &profile, const Key &key) {
  if (!std::filesystem::exists(profile / "Login Data") &&
      !std::filesystem::exists(profile / "Login Data For Account"))
    return Json::array();
  std::atomic_bool cancelled{false};
  int blocked = 0;
  auto items = chromiumLoginsImpl(profile, key, cancelled, blocked);
  if (blocked)
    return nullptr;
  Json out = Json::array();
  for (auto &item : items)
    out.push_back({{"origin", item.value("realm", item.value("url", ""))},
                   {"url", item["url"]},
                   {"username", item["username"]},
                   {"password", item["password"]},
                   {"created", item.value("created", 0.0)}});
  return out;
}
Json readEnginePasswords(const Path &root, const Path &profile) {
  if (!std::filesystem::exists(profile / "Login Data") &&
      !std::filesystem::exists(profile / "Login Data For Account"))
    return Json::array();
  auto key = chromiumKey(root);
  WipeSecretBytes wipe{key};
  return enginePasswords(profile, key);
}
Json readEnginePasswords(const Path &profile,
                         const EnginePasswordDecryptor &decryptor) {
  if (!decryptor)
    return nullptr;
  return enginePasswords(profile, decryptor);
}
template <class Key>
SensitiveImport chromiumAutofillImpl(const Path &profile, const Key &key,
                                     const std::atomic_bool &cancelled,
                                     int &blocked) {
  auto answer =
      readSealed("chromiumAutofill", profile, cancelled, opener(key));
  SensitiveImport out;
  out.addresses = std::move(answer["addresses"]);
  out.cards = std::move(answer["cards"]);
  blocked = answer.value("blocked", 0);
  return out;
}
SensitiveImport chromiumAutofill(const Path &profile, const Bytes &key,
                                 const std::atomic_bool &cancelled,
                                 int &blocked) {
  return chromiumAutofillImpl(profile, key, cancelled, blocked);
}
SensitiveImport chromiumAutofill(const Path &profile,
                                 const ChromiumSecretContext &context,
                                 const std::atomic_bool &cancelled,
                                 int &blocked) {
  return chromiumAutofillImpl(profile, context, cancelled, blocked);
}
} // namespace bay::importer
