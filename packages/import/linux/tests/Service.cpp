#include "../ChromiumSecrets.h"
#include <condition_variable>
#include <cstdlib>
#include <fstream>
#include <future>
#include <iostream>
#include <mutex>
#include <openssl/evp.h>
#include <sqlite3.h>

using namespace bay::importer;
namespace {
void require(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
Json envelope(const std::string &method, Json args = Json::array()) {
  return Json::parse(InvokeEnvelope(method, args.dump()));
}
Json call(const std::string &method, Json args = Json::array()) {
  auto result = envelope(method, std::move(args));
  require(!result.contains("error"), result.dump().c_str());
  return result.at("value");
}
Bytes encrypted(const std::string &value, const std::string &password,
                char version) {
  Bytes key(16);
  constexpr unsigned char salt[] = "saltysalt", iv[] = "                ";
  require(PKCS5_PBKDF2_HMAC_SHA1(password.data(), password.size(), salt, 9, 1,
                                 16, key.data()) == 1,
          "fixture key derivation failed");
  auto *cipher = EVP_CIPHER_CTX_new();
  require(cipher, "fixture cipher allocation failed");
  struct Free {
    EVP_CIPHER_CTX *cipher;
    ~Free() { EVP_CIPHER_CTX_free(cipher); }
  } free{cipher};
  Bytes bytes(value.size() + 32);
  int count = 0, last = 0;
  require(EVP_EncryptInit_ex(cipher, EVP_aes_128_cbc(), nullptr, key.data(),
                             iv) == 1 &&
              EVP_EncryptUpdate(
                  cipher, bytes.data(), &count,
                  reinterpret_cast<const unsigned char *>(value.data()),
                  value.size()) == 1 &&
              EVP_EncryptFinal_ex(cipher, bytes.data() + count, &last) == 1,
          "fixture encryption failed");
  bytes.resize(count + last);
  bytes.insert(bytes.begin(), {'v', '1', static_cast<unsigned char>(version)});
  bay::sync::erase(key);
  return bytes;
}
void profile(const Path &root) {
  std::filesystem::create_directories(root / "Default");
  std::ofstream(root / "Local State")
      << R"({"profile":{"info_cache":{"Default":{"name":"Test"}}}})";
  sqlite3 *database = nullptr;
  require(sqlite3_open((root / "Default/Login Data").c_str(), &database) ==
              SQLITE_OK,
          "fixture database unavailable");
  struct Close {
    sqlite3 *database;
    ~Close() { sqlite3_close(database); }
  } close{database};
  require(sqlite3_exec(database,
                       "CREATE TABLE logins(origin_url TEXT, username_value "
                       "TEXT, password_value BLOB)",
                       nullptr, nullptr, nullptr) == SQLITE_OK,
          "fixture table failed");
  for (auto version : {'0', '1'}) {
    auto bytes =
        encrypted(version == '0' ? "fixed-value" : "wallet-value",
                  version == '0' ? "peanuts" : "fixture-password", version);
    sqlite3_stmt *statement = nullptr;
    require(sqlite3_prepare_v2(database, "INSERT INTO logins VALUES(?,?,?)", -1,
                               &statement, nullptr) == SQLITE_OK,
            "fixture insert failed");
    sqlite3_bind_text(statement, 1, "https://example.test", -1, SQLITE_STATIC);
    sqlite3_bind_text(statement, 2, version == '0' ? "fixed" : "wallet", -1,
                      SQLITE_STATIC);
    sqlite3_bind_blob(statement, 3, bytes.data(), bytes.size(),
                      SQLITE_TRANSIENT);
    const auto status = sqlite3_step(statement);
    sqlite3_finalize(statement);
    require(status == SQLITE_DONE, "fixture row failed");
  }
}
class Lookup final : public LinuxSecretLookup {
  std::mutex mutex_;
  std::condition_variable changed_;
  bool block_ = false, entered_ = false;

public:
  std::atomic_int calls{0};
  Bytes lookup(LinuxChromiumBrowser browser, LinuxSecretBackend) override {
    require(browser == LinuxChromiumBrowser::Chrome,
            "wrong product keyring identity");
    ++calls;
    std::unique_lock<std::mutex> lock(mutex_);
    entered_ = true;
    changed_.notify_all();
    changed_.wait(lock, [&] { return !block_; });
    const std::string password = "fixture-password";
    return Bytes(password.begin(), password.end());
  }
  void block() {
    std::lock_guard<std::mutex> lock(mutex_);
    block_ = true;
    entered_ = false;
  }
  void wait() {
    std::unique_lock<std::mutex> lock(mutex_);
    require(changed_.wait_for(lock, std::chrono::seconds(5),
                              [&] { return entered_; }),
            "unlock never entered fake backend");
  }
  void release() {
    std::lock_guard<std::mutex> lock(mutex_);
    block_ = false;
    changed_.notify_all();
  }
};
Json import(const std::string &id, const std::string &job) {
  return Json::parse(
      call("importData", {job, id, "Default", {"passwords"}, Json::object()})
          .get<std::string>());
}
} // namespace
int main(int argc, char **argv) {
  try {
    require(argc == 2, "expected temporary fixture home");
    std::filesystem::create_directories(argv[1]);
    const Path home = std::filesystem::canonical(argv[1]),
               config = home / "config";
    // This disposable test process must never inspect the user's profiles.
    setenv("HOME", home.c_str(), 1);
    setenv("XDG_CONFIG_HOME", config.c_str(), 1);
    profile(config / "google-chrome");
    const Path flatpak =
        home / ".var/app/com.google.Chrome/config/google-chrome";
    profile(flatpak);
    auto lookup = std::make_shared<Lookup>();
    ScopedLinuxSecretLookupForTesting scoped(lookup);
    call("forgetUnlockedKeys");
    auto listed = Json::parse(call("listBrowsers").get<std::string>());
    std::string flatpakId;
    for (auto &source : listed)
      for (auto &p : source["profiles"])
        if (p["path"] == (flatpak / "Default").string())
          flatpakId = source["id"];
    require(!flatpakId.empty() && flatpakId != "chrome",
            "sandbox source identity collided");
    require(lookup->calls == 0, "discovery contacted a keyring");
    auto locked = import("chrome", "locked");
    require(locked["credentials"].size() == 1 &&
                locked["credentials"][0]["password"] == "fixed-value" &&
                !locked["warnings"].empty(),
            "locked import did not distinguish v10/v11");
    require(lookup->calls == 0, "import contacted keyring without consent");
    call("unlockBrowser", {"chrome", nullptr});
    require(lookup->calls == 1 && call("isBrowserUnlocked", {"chrome"}) == true,
            "explicit unlock did not populate source cache");
    auto unlocked = import("chrome", "unlocked");
    require(unlocked["credentials"].size() == 2, "unlocked v11 row missing");
    require(import(flatpakId, "sandbox")["credentials"].size() == 1 &&
                call("isBrowserUnlocked", {flatpakId}) == false &&
                lookup->calls == 1,
            "native consent leaked into sandbox source");
    require(envelope("unlockBrowser", {"arbitrary-keyring-attribute", nullptr})
                    .contains("error") &&
                lookup->calls == 1,
            "untrusted identity reached keyring");
    const auto changed = home / "changed-config";
    profile(changed / "google-chrome");
    setenv("XDG_CONFIG_HOME", changed.c_str(), 1);
    require(call("isBrowserUnlocked", {"chrome"}) == false,
            "changed source root reused cached consent");
    require(import("chrome", "changed")["credentials"].size() == 1 &&
                lookup->calls == 1,
            "changed source root reused cached key");
    setenv("XDG_CONFIG_HOME", config.c_str(), 1);
    call("forgetUnlockedKeys");
    require(call("isBrowserUnlocked", {"chrome"}) == false,
            "forget retained cached consent");
    lookup->block();
    auto pending = std::async(std::launch::async, [] {
      return envelope("unlockBrowser", {"chrome", nullptr});
    });
    try {
      lookup->wait();
      call("forgetUnlockedKeys");
    } catch (...) {
      lookup->release();
      throw;
    }
    lookup->release();
    auto forgotten = pending.get();
    require(forgotten.contains("error") &&
                forgotten["error"]["code"] == "cancelled" &&
                call("isBrowserUnlocked", {"chrome"}) == false,
            "late unlock repopulated forgotten key cache");
    call("unlockBrowser", {"chrome", nullptr});
    require(import("chrome", "retry")["credentials"].size() == 2,
            "retry after cancelled unlock failed");
    call("forgetUnlockedKeys");
    const auto first = home / "first-source", second = home / "second-source";
    std::filesystem::rename(config / "google-chrome", first);
    profile(second);
    std::filesystem::create_directory_symlink(first, config / "google-chrome");
    call("unlockBrowser", {"chrome", nullptr});
    require(import("chrome", "symlink-first")["credentials"].size() == 2,
            "symlinked source could not unlock");
    const auto calls = lookup->calls.load();
    std::filesystem::remove(config / "google-chrome");
    std::filesystem::create_directory_symlink(second, config / "google-chrome");
    require(call("isBrowserUnlocked", {"chrome"}) == false &&
                import("chrome", "symlink-second")["credentials"].size() == 1 &&
                lookup->calls == calls,
            "retargeted source inherited another root's keyring consent");
    call("forgetUnlockedKeys");
    std::cout << "Linux import consent/cache/service fixtures passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
