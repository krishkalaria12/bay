// Copyright 2026 Bay. Apache-2.0.
#include "data_services.h"
#include "packages/sync/windows/SyncCrypto.h"
#include "packages/sync/windows/SyncService.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>

#if !defined(_WIN32) && (!defined(__linux__) || defined(BAY_SYNC_PORTABLE_TEST))
// The service test uses the shipped CNG/Credential Manager implementation on
// Windows. macOS tests never access a real secret store.
namespace bay::sync {
#if defined(BAY_IMPORT_LINUX_TEST)
// Process-only fixture credentials, never persisted or shared with the desktop.
std::map<std::string, Bytes> testSecrets;
bool saveSecret(const std::string &account, const Bytes &value) {
  testSecrets[account] = value;
  return true;
}
std::optional<Bytes> loadSecret(const std::string &account) {
  auto found = testSecrets.find(account);
  return found == testSecrets.end() ? std::nullopt
                                    : std::optional<Bytes>(found->second);
}
void deleteSecret(const std::string &account) {
  auto found = testSecrets.find(account);
  if (found != testSecrets.end()) {
    erase(found->second);
    testSecrets.erase(found);
  }
}
#else
bool saveSecret(const std::string &, const Bytes &) {
  throw Failure("unsupported",
                "Windows credentials are unavailable in this test");
}
std::optional<Bytes> loadSecret(const std::string &) {
  throw Failure("unsupported",
                "Windows credentials are unavailable in this test");
}
void deleteSecret(const std::string &) {
  throw Failure("unsupported",
                "Windows credentials are unavailable in this test");
}
#endif
} // namespace bay::sync
#endif

#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
#include "packages/import/linux/ChromiumSecrets.h"
#include "packages/import/windows/SQLite.h"
#include <openssl/evp.h>
#endif

namespace {
using Json = nlohmann::json;
void Require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}
std::string NativePath(const std::filesystem::path &path) {
#ifdef _WIN32
  const auto utf8 = path.u8string();
  return std::string(utf8.begin(), utf8.end());
#else
  return path.native();
#endif
}
Json Invoke(const std::string &module, const std::string &method,
            const std::string &arguments) {
  return Json::parse(bay::data::Invoke(module, method, arguments));
}
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
class NoSecretLookup final : public bay::importer::LinuxSecretLookup {
public:
  int calls = 0;
  bay::sync::Bytes lookup(bay::importer::LinuxChromiumBrowser,
                          bay::importer::LinuxSecretBackend) override {
    ++calls;
    throw std::runtime_error("Sync must not unlock a source browser keyring");
  }
};
void AddPassword(const std::filesystem::path &profile, char version) {
  constexpr unsigned char key[] = {0xfd, 0x62, 0x1f, 0xe5, 0xa2, 0xb4,
                                   0x02, 0x53, 0x9d, 0xfa, 0x14, 0x7c,
                                   0xa9, 0x27, 0x27, 0x78};
  constexpr unsigned char iv[] = "                ";
  constexpr unsigned char password[] = "fixture-password";
  std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> cipher(
      EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
  bay::sync::Bytes encrypted(64);
  int count = 0, last = 0;
  Require(cipher &&
              EVP_EncryptInit_ex(cipher.get(), EVP_aes_128_cbc(), nullptr, key,
                                 iv) == 1 &&
              EVP_EncryptUpdate(cipher.get(), encrypted.data(), &count,
                                password, sizeof(password) - 1) == 1 &&
              EVP_EncryptFinal_ex(cipher.get(), encrypted.data() + count,
                                  &last) == 1,
          "Could not encrypt the password fixture");
  encrypted.resize(count + last);
  encrypted.insert(encrypted.begin(),
                   {'v', '1', static_cast<unsigned char>(version)});
  sqlite3 *database = nullptr;
  Require(sqlite3_open((profile / "Login Data").c_str(), &database) ==
              SQLITE_OK,
          "Could not open the password fixture");
  std::unique_ptr<sqlite3, decltype(&sqlite3_close)> close(database,
                                                           sqlite3_close);
  Require(sqlite3_exec(
              database,
              "CREATE TABLE IF NOT EXISTS logins(origin_url TEXT, "
              "signon_realm TEXT, username_value TEXT, password_value BLOB)",
              nullptr, nullptr, nullptr) == SQLITE_OK,
          "Could not create the password fixture");
  sqlite3_stmt *statement = nullptr;
  Require(sqlite3_prepare_v2(database, "INSERT INTO logins VALUES(?,?,?,?)", -1,
                             &statement, nullptr) == SQLITE_OK,
          "Could not prepare the password fixture");
  std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> finalize(
      statement, sqlite3_finalize);
  sqlite3_bind_text(statement, 1, "https://fixture.test/login", -1,
                    SQLITE_STATIC);
  sqlite3_bind_text(statement, 2, "https://fixture.test/", -1, SQLITE_STATIC);
  sqlite3_bind_text(statement, 3, "fixture-user", -1, SQLITE_STATIC);
  sqlite3_bind_blob(statement, 4, encrypted.data(), encrypted.size(),
                    SQLITE_TRANSIENT);
  Require(sqlite3_step(statement) == SQLITE_DONE,
          "Could not insert the password fixture");
}
void ReplacePasswordCiphertext(const std::filesystem::path &profile,
                               const std::string &ciphertext) {
  sqlite3 *database = nullptr;
  Require(sqlite3_open(NativePath(profile / "Login Data").c_str(), &database) ==
              SQLITE_OK,
          "Could not open password fixture");
  std::unique_ptr<sqlite3, decltype(&sqlite3_close)> close(database,
                                                           sqlite3_close);
  sqlite3_stmt *statement = nullptr;
  Require(sqlite3_prepare_v2(database, "UPDATE logins SET password_value = ?",
                             -1, &statement, nullptr) == SQLITE_OK,
          "Could not prepare password fixture update");
  std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> finalize(
      statement, sqlite3_finalize);
  sqlite3_bind_blob(statement, 1, ciphertext.data(), ciphertext.size(),
                    SQLITE_TRANSIENT);
  Require(sqlite3_step(statement) == SQLITE_DONE,
          "Could not update password ciphertext");
}
#endif
} // namespace

int main(int argc, char **argv) {
  try {
    Require(argc == 2, "Missing temporary data directory");
    const auto root = std::filesystem::absolute(argv[1]);
    std::filesystem::create_directories(root / "Profile-loaded");
    Require(bay::data::ModuleNames() ==
                std::vector<std::string>{"BayImport", "BaySync"},
            "Native data modules were not registered");
    const auto &methods = bay::data::MethodNames("BaySync");
    Require(std::find(methods.begin(), methods.end(), "readPasswords") !=
                methods.end(),
            "Sync did not register password reads");
    Require(Invoke("BaySync", "newDeviceId", "[]")["value"].is_string(),
            "Sync dispatch did not reach cryptography");
    Require(bay::data::MethodNames("MissingModule").empty(),
            "An unknown module advertised methods");
    std::string resolved;
    bay::data::Configure(NativePath(root), [&](const std::string &profile) {
      // Profile resolution may run on a UI sequence that also queries keys.
      // Reentry here must not wait on the password reader's key-state lock.
      (void)bay::sync::RecoveryKeyGeneration();
      resolved = profile;
      if (profile == "loaded")
        return bay::data::ProfilePaths{NativePath(root),
                                       NativePath(root / "Profile-loaded")};
      if (profile == "missing-root")
        return bay::data::ProfilePaths{"", NativePath(root / "Profile-loaded")};
      if (profile == "missing-path")
        return bay::data::ProfilePaths{NativePath(root), ""};
      return bay::data::ProfilePaths{};
    });
    for (const std::string profile : {"", "Default", "missing", "private",
                                      "missing-root", "missing-path"}) {
      auto reply =
          Invoke("BaySync", "readPasswords", Json::array({profile}).dump());
      Require(reply["error"]["code"] == "profile_unavailable",
              "An unresolved profile fell back to another profile");
      Require(resolved == profile, "The profile identifier was rewritten");
    }
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
    Require(
        Invoke("BaySync", "readPasswords", "[\"loaded\"]")["value"].is_null(),
        "A read before browser crypt initialization was treated as deletion");
    bool desktopAvailable = false;
    int desktopDecryptions = 0;
    const std::string desktopCiphertext("desktop\0fixture", 15);
    bay::data::SetPasswordDecryptor(
        [&](const std::string &ciphertext) -> std::optional<std::string> {
          if (ciphertext.compare(0, 3, "v11") == 0 ||
              ciphertext.compare(0, 3, "v12") == 0) {
            ++desktopDecryptions;
            if (desktopAvailable && ciphertext.substr(3) == desktopCiphertext)
              return "desktop-password";
            return std::nullopt;
          }
          auto plaintext = bay::importer::decryptLinuxChromiumSecret(
              bay::sync::Bytes(ciphertext.begin(), ciphertext.end()),
              bay::importer::linuxChromiumSecrets(
                  bay::importer::LinuxChromiumBrowser::Chromium));
          auto result = std::string(plaintext.begin(), plaintext.end());
          bay::sync::erase(plaintext);
          return result;
        });
#endif
    // A loaded profile without login data is a valid empty result, distinct
    // from refusing an unknown profile. Nothing should be created under
    // Default.
    auto reply = Invoke("BaySync", "readPasswords", "[\"loaded\"]");
    Require(reply.contains("value") && reply["value"] == Json::array(),
            "The loaded-profile password read did not reach its explicit path");
    Require(!std::filesystem::exists(root / "Default"),
            "Password reading created a default profile");
    Require(Invoke("BaySync", "readPasswords",
                   "[\"../other\"]")["error"]["code"] == "format",
            "A profile path escaped identifier validation");
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
    auto lookup = std::make_shared<NoSecretLookup>();
    bay::importer::ScopedLinuxSecretLookupForTesting noKeyring(lookup);
    AddPassword(root / "Profile-loaded", '0');
    reply = Invoke("BaySync", "readPasswords", "[\"loaded\"]");
    Require(
        reply.contains("value") && reply["value"].size() == 1 &&
            reply["value"][0]["password"] == "fixture-password" &&
            reply["value"][0]["username"] == "fixture-user" &&
            reply["value"][0]["origin"] == "https://fixture.test/",
        "Sync did not read and decrypt its authorized profile through import");
    // Incomplete reads must remain null. An empty/partial list can erase
    // passwords on another device when sync reconciles it as deletion.
    AddPassword(root / "Profile-loaded", '1');
    Require(
        Invoke("BaySync", "readPasswords", "[\"loaded\"]")["value"].is_null(),
        "An unreadable password row was reported as a complete list");
    for (const char *tag : {"v11", "v12"}) {
      ReplacePasswordCiphertext(root / "Profile-loaded",
                                std::string(tag) + desktopCiphertext);
      desktopAvailable = false;
      Require(
          Invoke("BaySync", "readPasswords", "[\"loaded\"]")["value"].is_null(),
          "An unavailable desktop provider was treated as password deletion");
      desktopAvailable = true;
      auto desktop = Invoke("BaySync", "readPasswords", "[\"loaded\"]");
      Require(desktop.contains("value") && desktop["value"].size() == 1 &&
                  desktop["value"][0]["password"] == "desktop-password",
              "Sync did not use the browser's desktop/portal decryptor");
    }
    Require(desktopDecryptions > 0, "The browser decryptor was not called");
    Require(lookup->calls == 0, "Sync opened a source browser keyring");
    std::filesystem::rename(root / "Profile-loaded" / "Login Data",
                            root / "Profile-loaded" / "Login Data For Account");
    Require(
        Invoke("BaySync", "readPasswords", "[\"loaded\"]")["value"].size() == 1,
        "Account-store-only passwords were reported as an empty list");
    std::ofstream(root / "Profile-loaded" / "Login Data")
        << "broken SQLite file";
    Require(
        Invoke("BaySync", "readPasswords", "[\"loaded\"]")["value"].is_null(),
        "An unreadable database was reported as an empty password list");
#endif
#if defined(BAY_IMPORT_LINUX_TEST)
    auto callSync = [](const std::string &method, Json args = Json::array()) {
      auto envelope = Invoke("BaySync", method, args.dump());
      Require(envelope.contains("value"), "Sync lifecycle dispatch failed");
      return envelope.at("value");
    };
    Require(callSync("createPhrase", {"fixture-account"}) == true,
            "Sync did not create a recovery key");
    auto words = callSync("recoveryWords");
    Require(words.size() == 24, "Sync did not derive recovery words");
    auto sealed = callSync("sealLocal", {"private fixture payload"});
    Require(callSync("openLocal", {sealed}) == "private fixture payload",
            "Sync did not decrypt local ciphertext");
    const auto chain = NativePath(root / "sync-folder");
    callSync("createChain", {chain});
    auto file =
        callSync("write", {chain, "fixture-scope", "sync fixture payload"});
    auto listing = callSync("read", {chain, "fixture-scope", Json::array()});
    Require(listing["files"].size() == 1 && listing["files"][0]["id"] == file &&
                listing["files"][0]["payload"] == "sync fixture payload",
            "Sync vault dispatch did not round-trip its payload");
    callSync("forget", {"fixture-account"});
    Require(callSync("unlock", {"fixture-account"}) == false &&
                callSync("openLocal", {sealed}).is_null() &&
                Invoke("BaySync", "recoveryWords", "[]")["error"]["code"] ==
                    "locked",
            "Forgetting sync retained an unlocked recovery key");
#endif
    Require(Invoke("BayImport", "importData", "{}")["error"]["code"] ==
                "invalid_arguments",
            "A non-array argument crossed the service boundary");
    Require(Invoke("BaySync", "readPasswords", "{}")["error"]["code"] ==
                "invalid_arguments",
            "Non-array sync arguments crossed the service boundary");
    Require(Invoke("BaySync", "readPasswords", "[]")["error"]["code"] ==
                "invalid_arguments",
            "A missing argument escaped the service envelope");
    Require(Invoke("BaySync", "missing", "[]")["error"]["code"] ==
                "unsupported",
            "An unknown method was accepted");
    Require(Invoke("BayImport", "missing", "[]")["error"]["code"] ==
                "unsupported",
            "An unknown import method was accepted");
    Require(Invoke("BayImport", "importData", "[]")["error"]["code"] ==
                "invalid_arguments",
            "Missing import arguments crossed the service boundary");
    Require(Invoke("MissingModule", "missing", "[]")["error"]["code"] ==
                "unsupported",
            "An unknown module was accepted");
    Require(bay::data::RequiresUIThread("BayImport", "chooseImportFile") &&
                bay::data::RequiresUIThread("BaySync", "saveRecoveryKit") &&
                !bay::data::RequiresUIThread("BaySync", "readPasswords") &&
                !bay::data::RequiresUIThread("BayImport", "importData"),
            "Blocking work or native dialogs use the wrong thread");
    bay::data::Configure(NativePath(root), {});
    Require(Invoke("BaySync", "readPasswords",
                   "[\"loaded\"]")["error"]["code"] == "profile_unavailable",
            "A missing profile resolver was accepted");
    bay::data::Configure(
        NativePath(root),
        [](const std::string &) -> bay::data::ProfilePaths { throw 42; });
    Require(Invoke("BaySync", "readPasswords",
                   "[\"loaded\"]")["error"]["code"] == "native_failure",
            "An exception escaped into the Chromium caller");
    bay::data::SetPasswordDecryptor({});
    std::cout << "Native data envelopes and thread routing passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
