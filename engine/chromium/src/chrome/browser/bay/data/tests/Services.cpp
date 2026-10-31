// Copyright 2026 Bay. Apache-2.0.
#include "data_services.h"
#include "packages/sync/windows/SyncCrypto.h"

#include <filesystem>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>

#ifndef _WIN32
// The service test uses the shipped CNG/Credential Manager implementation on
// Windows. macOS tests never substitute a persistent or plaintext secret store.
namespace bay::sync {
bool saveSecret(const std::string&, const Bytes&) {
  throw Failure("unsupported",
                "Windows credentials are unavailable in this test");
}
std::optional<Bytes> loadSecret(const std::string&) {
  throw Failure("unsupported",
                "Windows credentials are unavailable in this test");
}
void deleteSecret(const std::string&) {
  throw Failure("unsupported",
                "Windows credentials are unavailable in this test");
}
}  // namespace bay::sync
#endif

namespace {
using Json = nlohmann::json;
void Require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
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
    bay::data::Configure(root.u8string(), [&](const std::string& profile) {
      resolved = profile;
      if (profile == "loaded")
        return bay::data::ProfilePaths{root.u8string(),
                                       (root / "Profile-loaded").u8string()};
      return bay::data::ProfilePaths{};
    });
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
    Require(Invoke("BayImport", "importData", "{}")["error"]["code"] ==
                "invalid_arguments",
            "A non-array argument crossed the service boundary");
    Require(Invoke("BaySync", "readPasswords", "[]")["error"]["code"] ==
                "invalid_arguments",
            "A missing argument escaped the service envelope");
    Require(
        Invoke("BaySync", "missing", "[]")["error"]["code"] == "unsupported",
        "An unknown method was accepted");
    Require(Invoke("MissingModule", "missing", "[]")["error"]["code"] ==
                "unsupported",
            "An unknown module was accepted");
    Require(bay::data::RequiresUIThread("BayImport", "chooseImportFile") &&
                bay::data::RequiresUIThread("BaySync", "saveRecoveryKit") &&
                !bay::data::RequiresUIThread("BaySync", "readPasswords") &&
                !bay::data::RequiresUIThread("BayImport", "importData"),
            "Blocking work or native dialogs use the wrong thread");
    bay::data::Configure(root.u8string(), {});
    Require(Invoke("BaySync", "readPasswords",
                   "[\"loaded\"]")["error"]["code"] == "profile_unavailable",
            "A missing profile resolver was accepted");
    bay::data::Configure(
        root.u8string(),
        [](const std::string&) -> bay::data::ProfilePaths { throw 42; });
    Require(Invoke("BaySync", "readPasswords",
                   "[\"loaded\"]")["error"]["code"] == "native_failure",
            "An exception escaped into the Chromium caller");
    std::cout << "Native data envelopes, loaded-profile isolation and thread "
                 "routing passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
