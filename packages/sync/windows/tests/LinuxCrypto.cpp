#include "../SyncCrypto.h"
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <sstream>
#include <sys/stat.h>

namespace bay::sync {
std::string testNamespace = "crypto-test";
std::string GetSecretNamespace() { return testNamespace; }
// Exercise the no-Secret-Service path without a desktop or a persisted secret.
bool saveSecret(const std::string &, const Bytes &) { return false; }
std::optional<Bytes> loadSecret(const std::string &) { return std::nullopt; }
void deleteSecret(const std::string &) {}
} // namespace bay::sync
using namespace bay::sync;
void require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}
Bytes unhex(const std::string &text) {
  Bytes out;
  for (std::size_t i = 0; i < text.size(); i += 2)
    out.push_back(
        static_cast<std::uint8_t>(std::stoul(text.substr(i, 2), nullptr, 16)));
  return out;
}
int main(int argc, char **argv) {
  try {
    require(argc == 3, "expected golden vector and temporary directory");
    std::ifstream input(argv[1]);
    nlohmann::json vector;
    input >> vector;
    auto entropy = unhex(vector.at("entropy"));
    Keys keys(entropy);
    require(keys.chainTag() == vector.at("chainTag"),
            "chain tag differs from Swift");
    auto scope = keys.scopeTag(vector.at("scope"));
    require(scope == vector.at("scopeTag"), "scope tag differs from Swift");
    auto text = vector.at("payload").get<std::string>();
    Bytes payload(text.begin(), text.end());
    auto sealed = keys.sealWithNonce(payload, scope, vector.at("fileId"),
                                     unhex(vector.at("nonce")));
    require(sealed == unhex(vector.at("sealed")),
            "encrypted envelope differs from CryptoKit");
    require(keys.open(sealed, scope, vector.at("fileId")) == payload,
            "Swift envelope failed to open");
    for (auto corrupt : {0u, 20u, static_cast<unsigned>(sealed.size() - 1)}) {
      auto changed = sealed;
      changed[corrupt] ^= 1;
      bool refused = false;
      try {
        keys.open(changed, scope, vector.at("fileId"));
      } catch (const Failure &) {
        refused = true;
      }
      require(refused, "modified ciphertext was accepted");
    }
    bool refused = false;
    try {
      keys.open(sealed, keys.scopeTag("another-profile"), vector.at("fileId"));
    } catch (const Failure &) {
      refused = true;
    }
    require(refused, "ciphertext moved to another profile was accepted");
    auto words = recoveryWords(entropy);
    std::string phrase;
    for (auto &word : words) {
      if (!phrase.empty())
        phrase += ' ';
      phrase += word;
    }
    require(words.size() == 24 && recoveryEntropy(phrase) == entropy,
            "recovery phrase round trip failed");
    std::filesystem::path folder(argv[2]);
    std::filesystem::create_directories(folder);
    for (unsigned invalid = 0; invalid < 3; ++invalid) {
      bool rejected = false;
      try {
        if (invalid == 0)
          aesGcmSeal(Bytes(31), Bytes(12), {}, {});
        if (invalid == 1)
          aesGcmSeal(Bytes(32), Bytes(11), {}, {});
        if (invalid == 2)
          aesGcmOpen(Bytes(32), Bytes(12), Bytes(15), {});
      } catch (const Failure &error) {
        rejected = error.code == "format";
      }
      require(rejected, "invalid AES-GCM key, nonce or tag accepted");
    }
    auto secret = protect(payload);
    require(unprotect(secret) == payload, "local protection round trip failed");
    testNamespace = "other-profile";
    bool otherProfileRefused = false;
    try {
      unprotect(secret);
    } catch (const Failure &) {
      otherProfileRefused = true;
    }
    require(otherProfileRefused, "local key crossed profile namespaces");
    testNamespace = "crypto-test";
    require(unprotect(secret) == payload,
            "switching profiles lost session key");
    secret.back() ^= 1;
    bool localRefused = false;
    try {
      unprotect(secret);
    } catch (const Failure &) {
      localRefused = true;
    }
    require(localRefused, "tampered local protection accepted");
    require(aesGcmOpen(Bytes(32), Bytes(12),
                       aesGcmSeal(Bytes(32), Bytes(12), {}, {}), {})
                .empty(),
            "empty AES-GCM failed");
    auto privateFolder = folder / "private";
    createPrivateDirectory(privateFolder);
    struct stat info{};
    require(stat(privateFolder.c_str(), &info) == 0 &&
                (info.st_mode & 0777) == 0700,
            "private folder permissions differ");
    bool duplicateRefused = false;
    try {
      createPrivateDirectory(privateFolder);
    } catch (const Failure &) {
      duplicateRefused = true;
    }
    require(duplicateRefused, "existing private directory accepted");
    std::cout << "Linux crypto matches golden vector; tampering, profile "
                 "binding, recovery, local protection and permissions passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
