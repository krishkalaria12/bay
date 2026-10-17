#include "../RecoveryKit.h"
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
    auto qr = recoveryQrPNG(entropy);
    const Bytes signature{137, 80, 78, 71, 13, 10, 26, 10};
    require(qr.size() > 32 &&
                std::equal(signature.begin(), signature.end(), qr.begin()),
            "QR image is not a PNG");
    auto dimension = [&](unsigned start) {
      unsigned value = 0;
      for (unsigned i = start; i < start + 4; ++i)
        value = value * 256 + qr[i];
      return value;
    };
    require(dimension(16) == dimension(20) && dimension(16) >= 200,
            "QR image dimensions are invalid");
    {
      std::ofstream png(folder / "recovery-qr.png", std::ios::binary);
      png.write(reinterpret_cast<const char *>(qr.data()), qr.size());
    }
    auto pdf = recoveryKitPDF(entropy, "Windows test device");
    require(pdf.rfind("%PDF-1.4", 0) == 0 &&
                pdf.find("xref\n0 6\n") != std::string::npos,
            "Recovery kit is not a PDF");
    for (auto &word : words)
      require(pdf.find(word) != std::string::npos,
              "Recovery PDF lost a phrase word");
    require(pdf.find("re f\n") != std::string::npos &&
                recoveryKitText(entropy, "test").find("Windows") !=
                    std::string::npos,
            "Recovery kit is missing its QR or desktop instructions");
    {
      std::ofstream file(folder / "recovery-kit.pdf", std::ios::binary);
      file << pdf;
    }
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
                 "recovery, QR/PDF and vault tests passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
