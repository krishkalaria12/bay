#include "../SyncCrypto.h"
#include "../SyncVault.h"
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <sstream>

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
    Vault vault(folder, keys);
    auto id = vault.write("p:default", payload);
    auto listing = vault.read("p:default", {});
    require(listing.files.size() == 1 && listing.files[0].payload == payload,
            "vault round trip failed");
    require(vault.read("p:default", {id}).files.empty(),
            "known files were returned again");
    vault.remove("p:default", {id});
    require(vault.read("p:default", {}).present.empty(),
            "vault removal failed");
    vault.deleteChain();
    require(!vault.chainExists(), "chain removal failed");
    std::cout << "Sync format matches Swift; tampering, profile binding, "
                 "recovery and vault tests passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
