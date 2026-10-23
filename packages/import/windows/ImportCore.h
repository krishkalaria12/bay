#pragma once
#include "../../sync/windows/SyncCrypto.h"
#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
namespace bay::importer {
using Json = nlohmann::json;
using Bytes = bay::sync::Bytes;
using Path = std::filesystem::path;
using Failure = bay::sync::Failure;
struct Options {
  int historyLimit = -1;
  double historySince = 0;
  int chunkSize = 1000;
  bool streamHistory = false;
};
using Observer = std::function<void(const Json &)>;
std::string readText(const Path &path);
Bytes readBytes(const Path &path);
Json parsePasswordsCSV(const std::string &text);
Json parseNetscapeBookmarks(const std::string &text);
Json chromiumBookmarks(const Path &profile);
Json firefoxBookmarks(const Path &profile, const std::atomic_bool &cancelled);
Json history(const Path &profile, bool firefox, const Options &options,
             const Observer &observer, const std::atomic_bool &cancelled,
             int &count);
Json chromiumTabs(const Path &profile, const std::atomic_bool &cancelled);
Json firefoxTabs(const Path &profile, const std::atomic_bool &cancelled);
Json arcSidebar(const Path &file);
Json extensions(const Path &profile);
Json chromiumLogins(const Path &profile, const Bytes &key,
                    const std::atomic_bool &cancelled, int &blocked);
Json firefoxLogins(const Path &profile, const std::string &password,
                   const std::atomic_bool &cancelled);
Bytes chromiumKey(const Path &root);

// Linux source identity is selected from trusted discovery metadata. Never use
// a user-supplied string as a keyring attribute or Safe Storage label.
enum class LinuxChromiumBrowser {
  Chrome,
  Chromium,
  Brave,
  Edge,
  Vivaldi,
  Opera,
  Helium
};
enum class LinuxSecretBackend {
  Automatic,
  SecretService,
  KWallet,
  KWallet5,
  KWallet6
};
LinuxChromiumBrowser linuxChromiumBrowser(const std::string &productId);
class ChromiumSecretContext {
public:
  explicit ChromiumSecretContext(LinuxChromiumBrowser browser)
      : browser_(browser) {}
  ChromiumSecretContext(const ChromiumSecretContext &) = delete;
  ChromiumSecretContext &operator=(const ChromiumSecretContext &) = delete;
  ChromiumSecretContext(ChromiumSecretContext &&other) noexcept
      : browser_(other.browser_), v11_(std::move(other.v11_)) {}
  ChromiumSecretContext &operator=(ChromiumSecretContext &&other) noexcept {
    if (this != &other) {
      bay::sync::erase(v11_);
      browser_ = other.browser_;
      v11_ = std::move(other.v11_);
    }
    return *this;
  }
  ~ChromiumSecretContext() { bay::sync::erase(v11_); }
  LinuxChromiumBrowser browser() const { return browser_; }
  bool unlocked() const { return v11_.size() == 16; }

private:
  LinuxChromiumBrowser browser_;
  Bytes v11_;
  friend Bytes decryptLinuxChromiumSecret(const Bytes &,
                                          const ChromiumSecretContext &);
  friend ChromiumSecretContext
  unlockLinuxChromiumSecrets(LinuxChromiumBrowser, bool, LinuxSecretBackend,
                             class LinuxSecretLookup &);
};
// This creates a locked context and does not contact any secret service.
ChromiumSecretContext linuxChromiumSecrets(LinuxChromiumBrowser browser);
// Call only from explicit unlockBrowser consent, never listing or import.
ChromiumSecretContext unlockLinuxChromiumSecrets(
    LinuxChromiumBrowser browser, bool consent,
    LinuxSecretBackend backend = LinuxSecretBackend::Automatic);
Json chromiumLogins(const Path &profile, const ChromiumSecretContext &context,
                    const std::atomic_bool &cancelled, int &blocked);

Bytes decodeBase64(const std::string &text);
std::string encodeBase64(const Bytes &bytes);
void wipeJson(Json &value) noexcept;
struct SensitiveImport {
  Json cookies = Json::array(), addresses = Json::array(),
       cards = Json::array();
  SensitiveImport() = default;
  SensitiveImport(const SensitiveImport &) = delete;
  SensitiveImport &operator=(const SensitiveImport &) = delete;
  SensitiveImport(SensitiveImport &&) noexcept = default;
  SensitiveImport &operator=(SensitiveImport &&other) noexcept {
    if (this != &other) {
      wipeJson(cookies);
      wipeJson(addresses);
      wipeJson(cards);
      cookies = std::move(other.cookies);
      addresses = std::move(other.addresses);
      cards = std::move(other.cards);
    }
    return *this;
  }
  ~SensitiveImport() {
    wipeJson(cookies);
    wipeJson(addresses);
    wipeJson(cards);
  }
};
SensitiveImport chromiumAutofill(const Path &profile, const Bytes &key,
                                 const std::atomic_bool &cancelled,
                                 int &blocked);
SensitiveImport chromiumAutofill(const Path &profile,
                                 const ChromiumSecretContext &context,
                                 const std::atomic_bool &cancelled,
                                 int &blocked);
SensitiveImport firefoxCookies(const Path &profile,
                               const std::atomic_bool &cancelled);
inline std::string utf8(std::uint32_t cp) {
  std::string out;
  if (cp < 0x80)
    out += static_cast<char>(cp);
  else if (cp < 0x800) {
    out += static_cast<char>(0xc0 | (cp >> 6));
    out += static_cast<char>(0x80 | (cp & 63));
  } else if (cp < 0x10000) {
    out += static_cast<char>(0xe0 | (cp >> 12));
    out += static_cast<char>(0x80 | ((cp >> 6) & 63));
    out += static_cast<char>(0x80 | (cp & 63));
  } else {
    out += static_cast<char>(0xf0 | (cp >> 18));
    out += static_cast<char>(0x80 | ((cp >> 12) & 63));
    out += static_cast<char>(0x80 | ((cp >> 6) & 63));
    out += static_cast<char>(0x80 | (cp & 63));
  }
  return out;
}
void checkCancelled(const std::atomic_bool &cancelled);
using EventSink = std::function<void(const std::string &, const std::string &,
                                     const std::string &)>;
void SetEventSink(EventSink sink);
// Engine writer consumes secrets natively and must never serialize cookies/card
// values to JS.
using ImportWriter =
    std::function<Json(const std::string &, const std::vector<std::string> &,
                       const SensitiveImport &)>;
void SetImportWriter(ImportWriter writer);
Json readEnginePasswords(const Path &root, const Path &profile);
inline constexpr char kModuleName[] = "BayImport";
const std::vector<std::string> &MethodNames();
bool RequiresUIThread(const std::string &method);
std::string InvokeEnvelope(const std::string &method,
                           const std::string &argsJson);
std::string Invoke(const std::string &module, const std::string &method,
                   const std::string &argsJson);
} // namespace bay::importer
