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
void Require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}
std::string NativePath(const std::filesystem::path& path) {
#ifdef _WIN32
  const auto utf8 = path.u8string();
  return std::string(utf8.begin(), utf8.end());
#else
  return path.native();
#endif
}
Json Invoke(const std::string& module,
            const std::string& method,
            const std::string& arguments) {
  return Json::parse(bay::data::Invoke(module, method, arguments));
}
}  // namespace

int main(int argc, char** argv) {
  try {
    Require(argc == 2, "Missing temporary data directory");
    const auto root = std::filesystem::absolute(argv[1]);
    std::filesystem::create_directories(root / "Profile-loaded");
    std::string resolved;
    bay::data::Configure(NativePath(root), [&](const std::string& profile) {
      resolved = profile;
      if (profile == "loaded")
        return bay::data::ProfilePaths{NativePath(root),
                                       NativePath(root / "Profile-loaded")};
      return bay::data::ProfilePaths{};
    });
#if !defined(__linux__) && !defined(BAY_IMPORT_LINUX_TEST)
    for (const std::string profile : {"", "Default", "missing", "private"}) {
      auto reply =
          Invoke("BaySync", "readPasswords", Json::array({profile}).dump());
      Require(reply["error"]["code"] == "profile_unavailable",
              "An unresolved profile fell back to another profile");
      Require(resolved == profile, "The profile identifier was rewritten");
    }
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
#else
    Require(bay::data::ModuleNames() == std::vector<std::string>{"BayImport"},
            "Linux advertised an unfinished data module");
    Require(bay::data::MethodNames("BaySync").empty(),
            "Linux advertised unfinished sync methods");
    Require(Invoke("BaySync", "newDeviceId", "[]")["error"]["code"] ==
                "unsupported",
            "Linux dispatched an unfinished sync operation");
    Require(bay::data::RequiresUIThread("BayImport", "chooseImportFile") &&
                !bay::data::RequiresUIThread("BayImport", "importData") &&
                !bay::data::RequiresUIThread("BaySync", "saveRecoveryKit"),
            "Linux data methods use the wrong thread");
#endif
    Require(Invoke("BayImport", "importData", "{}")["error"]["code"] ==
                "invalid_arguments",
            "A non-array argument crossed the service boundary");
#if !defined(__linux__) && !defined(BAY_IMPORT_LINUX_TEST)
    Require(Invoke("BaySync", "readPasswords", "[]")["error"]["code"] ==
                "invalid_arguments",
            "A missing argument escaped the service envelope");
    Require(
        Invoke("BaySync", "missing", "[]")["error"]["code"] == "unsupported",
        "An unknown method was accepted");
#endif
    Require(
        Invoke("BayImport", "missing", "[]")["error"]["code"] == "unsupported",
        "An unknown import method was accepted");
    Require(Invoke("BayImport", "importData", "[]")["error"]["code"] ==
                "invalid_arguments",
            "Missing import arguments crossed the service boundary");
    Require(Invoke("MissingModule", "missing", "[]")["error"]["code"] ==
                "unsupported",
            "An unknown module was accepted");
#if !defined(__linux__) && !defined(BAY_IMPORT_LINUX_TEST)
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
        [](const std::string&) -> bay::data::ProfilePaths { throw 42; });
    Require(Invoke("BaySync", "readPasswords",
                   "[\"loaded\"]")["error"]["code"] == "native_failure",
            "An exception escaped into the Chromium caller");
#endif
    std::cout << "Native data envelopes and thread routing passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
