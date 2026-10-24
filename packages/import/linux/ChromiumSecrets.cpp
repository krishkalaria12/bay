#include "ChromiumSecrets.h"
#include <array>
#include <limits>
#include <mutex>
#include <openssl/evp.h>
namespace bay::importer {
Bytes lookupLinuxSafeStorage(LinuxChromiumBrowser, LinuxSecretBackend);
namespace {
std::mutex lookupMutex;
std::shared_ptr<LinuxSecretLookup> testLookup;
std::shared_ptr<LinuxSecretLookup>
replaceLookup(std::shared_ptr<LinuxSecretLookup> lookup) {
  std::lock_guard<std::mutex> lock(lookupMutex);
  auto previous = std::move(testLookup);
  testLookup = std::move(lookup);
  return previous;
}
} // namespace
ScopedLinuxSecretLookupForTesting::ScopedLinuxSecretLookupForTesting(
    std::shared_ptr<LinuxSecretLookup> lookup)
    : previous_(replaceLookup(std::move(lookup))) {}
ScopedLinuxSecretLookupForTesting::~ScopedLinuxSecretLookupForTesting() {
  replaceLookup(std::move(previous_));
}
LinuxChromiumBrowser linuxChromiumBrowser(const std::string &id) {
  if (id == "chrome")
    return LinuxChromiumBrowser::Chrome;
  if (id == "chromium")
    return LinuxChromiumBrowser::Chromium;
  if (id == "brave")
    return LinuxChromiumBrowser::Brave;
  if (id == "edge")
    return LinuxChromiumBrowser::Edge;
  if (id == "vivaldi")
    return LinuxChromiumBrowser::Vivaldi;
  if (id == "opera")
    return LinuxChromiumBrowser::Opera;
  if (id == "helium")
    return LinuxChromiumBrowser::Helium;
  throw Failure("unsupported", "Unknown Linux browser secret identity");
}
ChromiumSecretContext linuxChromiumSecrets(LinuxChromiumBrowser browser) {
  return ChromiumSecretContext(browser);
}
ChromiumSecretContext unlockLinuxChromiumSecrets(LinuxChromiumBrowser browser,
                                                 bool consent,
                                                 LinuxSecretBackend backend,
                                                 LinuxSecretLookup &lookup) {
  if (!consent)
    throw Failure("locked", "Consent is required to unlock browser secrets");
  auto secret = lookup.lookup(browser, backend);
  struct Wipe {
    Bytes &bytes;
    ~Wipe() { bay::sync::erase(bytes); }
  } wipe{secret};
  if (secret.empty() ||
      secret.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()))
    throw Failure("locked",
                  "The source browser Safe Storage secret is unavailable");
  ChromiumSecretContext context(browser);
  context.v11_.resize(16);
  constexpr unsigned char salt[] = "saltysalt";
  if (!PKCS5_PBKDF2_HMAC_SHA1(reinterpret_cast<const char *>(secret.data()),
                              static_cast<int>(secret.size()), salt, 9, 1, 16,
                              context.v11_.data()))
    throw Failure("crypto", "Could not derive the source browser key");
  return context;
}
ChromiumSecretContext unlockLinuxChromiumSecrets(LinuxChromiumBrowser browser,
                                                 bool consent,
                                                 LinuxSecretBackend backend) {
  // Reject missing consent before touching even an injected backend.
  if (!consent)
    throw Failure("locked", "Consent is required to unlock browser secrets");
  std::shared_ptr<LinuxSecretLookup> injected;
  {
    std::lock_guard<std::mutex> lock(lookupMutex);
    injected = testLookup;
  }
  if (injected)
    return unlockLinuxChromiumSecrets(browser, consent, backend, *injected);
  class Lookup final : public LinuxSecretLookup {
    Bytes lookup(LinuxChromiumBrowser browser,
                 LinuxSecretBackend backend) override {
      return lookupLinuxSafeStorage(browser, backend);
    }
  } lookup;
  return unlockLinuxChromiumSecrets(browser, consent, backend, lookup);
}
Bytes decryptLinuxChromiumSecret(const Bytes &value,
                                 const ChromiumSecretContext &context) {
  if (value.size() >= 3 && value[0] == 'v' && value[1] == '2' &&
      value[2] == '0')
    throw Failure(
        "appBound",
        "This browser secret format is unsupported. Export passwords as CSV");
  if (value.size() < 3 || value[0] != 'v' || value[1] != '1' ||
      (value[2] != '0' && value[2] != '1'))
    throw Failure("unsupported", "Unsupported Linux browser secret format");
  // Chromium PosixKeyProvider, pinned a654841: PBKDF2-SHA1(peanuts,
  // saltysalt, 1), 128 bits. v11 uses the independently derived key above.
  constexpr std::array<unsigned char, 16> fixedKey = {
      0xfd, 0x62, 0x1f, 0xe5, 0xa2, 0xb4, 0x02, 0x53,
      0x9d, 0xfa, 0x14, 0x7c, 0xa9, 0x27, 0x27, 0x78};
  auto key = fixedKey.data();
  if (value[2] == '1') {
    if (!context.unlocked())
      throw Failure("locked",
                    "Unlock the source browser before importing passwords");
    key = context.v11_.data();
  }
  auto size = value.size() - 3;
  if (!size || size % 16 ||
      size > static_cast<std::size_t>(std::numeric_limits<int>::max() - 16))
    throw Failure("format", "Invalid Linux browser ciphertext");
  constexpr unsigned char iv[] = "                ";
  EVP_CIPHER_CTX *cipher = EVP_CIPHER_CTX_new();
  if (!cipher)
    throw Failure("crypto", "Could not initialize browser decryption");
  struct Free {
    EVP_CIPHER_CTX *p;
    ~Free() { EVP_CIPHER_CTX_free(p); }
  } free{cipher};
  Bytes plain(size + 16);
  struct Wipe {
    Bytes &bytes;
    ~Wipe() { bay::sync::erase(bytes); }
  } wipe{plain};
  int first = 0, last = 0;
  if (EVP_DecryptInit_ex(cipher, EVP_aes_128_cbc(), nullptr, key, iv) != 1 ||
      EVP_DecryptUpdate(cipher, plain.data(), &first, value.data() + 3,
                        static_cast<int>(size)) != 1 ||
      EVP_DecryptFinal_ex(cipher, plain.data() + first, &last) != 1)
    throw Failure("locked", "The source browser secret could not be decrypted");
  // CBC has no authentication. Do not guess alternate keys on padding failure.
  Bytes result(plain.begin(), plain.begin() + first + last);
  return result;
}
} // namespace bay::importer
