#include "../ChromiumSecrets.h"
#include <dlfcn.h>
#include <fstream>
#include <iostream>
#include <nss.h>
#include <openssl/rand.h>
#include <pk11pub.h>
#include <pk11sdr.h>
#include <secitem.h>
#include <stdexcept>
using namespace bay::importer;
namespace bay::sync {
// Portable test adapter for the already-owned sync interface. This is not a
// Linux sync backend and is never part of the product target.
Bytes randomBytes(std::size_t count) {
  Bytes value(count);
  if (RAND_bytes(value.data(), static_cast<int>(value.size())) != 1)
    throw std::runtime_error("rng");
  return value;
}
void erase(Bytes &value) noexcept {
  volatile std::uint8_t *p = value.data();
  for (std::size_t i = 0; i < value.size(); ++i)
    p[i] = 0;
  value.clear();
}
std::string base32(const Bytes &bytes) {
  const char *hex = "0123456789abcdef";
  std::string out;
  for (auto c : bytes) {
    out += hex[c >> 4];
    out += hex[c & 15];
  }
  return out;
}
void createPrivateDirectory(const Path &path) {
  std::filesystem::create_directory(path);
  std::filesystem::permissions(path, std::filesystem::perms::owner_all,
                               std::filesystem::perm_options::replace);
}
} // namespace bay::sync
namespace {
void require(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void fails(const std::string &code, F f) {
  try {
    f();
  } catch (const Failure &failure) {
    require(failure.code == code, failure.what());
    return;
  }
  throw std::runtime_error("expected failure: " + code);
}
class Fake : public LinuxSecretLookup {
public:
  int calls = 0;
  bool error = false;
  Bytes secret{'t', 'e', 's', 't', '-', 's', 'a', 'f', 'e', '-', 's', 't',
               'o', 'r', 'a', 'g', 'e', '-', 's', 'e', 'c', 'r', 'e', 't'};
  LinuxChromiumBrowser expected = LinuxChromiumBrowser::Chrome;
  Bytes lookup(LinuxChromiumBrowser browser, LinuxSecretBackend) override {
    ++calls;
    require(browser == expected, "wrong source identity");
    if (error)
      throw Failure("locked", "fake denial");
    return secret;
  }
};
Bytes vector(const Json &vectors, const char *name) {
  return decodeBase64(vectors.at(name));
}
} // namespace
int main(int argc, char **argv) {
  try {
    require(argc == 2, "fixture root argument");
    Path root(argv[1]);
    auto vectors = Json::parse(readText(root / "vectors.json"));
    auto fake = std::make_shared<Fake>();
    auto locked = linuxChromiumSecrets(linuxChromiumBrowser("chrome"));
    require(!locked.unlocked() && fake->calls == 0,
            "locked context did a lookup");
    fails("unsupported",
          [] { linuxChromiumBrowser("chrome;application=bay"); });
    fails("locked", [&] {
      unlockLinuxChromiumSecrets(locked.browser(), false,
                                 LinuxSecretBackend::Automatic, *fake);
    });
    require(fake->calls == 0, "consent denial did a lookup");
    auto v10 = decryptLinuxChromiumSecret(vector(vectors, "v10"), locked);
    require(std::string(v10.begin(), v10.end()) == "fixed password",
            "v10 mismatch");
    fails("locked",
          [&] { decryptLinuxChromiumSecret(vector(vectors, "v11"), locked); });
    fails("appBound",
          [&] { decryptLinuxChromiumSecret(Bytes{'v', '2', '0', 0}, locked); });
    fails("unsupported",
          [&] { decryptLinuxChromiumSecret(Bytes{'v', '1', '2', 0}, locked); });
    fails("unsupported", [&] {
      decryptLinuxChromiumSecret(Bytes{'p', 'l', 'a', 'i', 'n'}, locked);
    });
    fails("format",
          [&] { decryptLinuxChromiumSecret(Bytes{'v', '1', '0'}, locked); });
    fails("format",
          [&] { decryptLinuxChromiumSecret(Bytes{'v', '1', '0', 0}, locked); });
    fails("locked", [&] {
      decryptLinuxChromiumSecret(vector(vectors, "badPadding"), locked);
    });
    {
      ScopedLinuxSecretLookupForTesting scope(fake);
      auto context = unlockLinuxChromiumSecrets(locked.browser(), true);
      auto plain = decryptLinuxChromiumSecret(vector(vectors, "v11"), context);
      require(std::string(plain.begin(), plain.end()) == "keyring password",
              "v11 mismatch");
      auto stillV10 =
          decryptLinuxChromiumSecret(vector(vectors, "v10"), context);
      require(stillV10 == v10, "unlocked v11 changed v10 key");
      auto moved = std::move(context);
      require(moved.unlocked() && !context.unlocked(), "context move");
      auto reassign = linuxChromiumSecrets(LinuxChromiumBrowser::Brave);
      reassign = std::move(moved);
      require(reassign.browser() == LinuxChromiumBrowser::Chrome &&
                  reassign.unlocked(),
              "context move assignment");
      std::atomic_bool cancelled{false};
      int blocked = 0;
      auto passwords =
          chromiumLogins(root / "chromium", reassign, cancelled, blocked);
      require(passwords.size() == 2 && blocked == 3, "mixed login schemes");
      auto autofill =
          chromiumAutofill(root / "chromium", reassign, cancelled, blocked);
      require(autofill.cards.size() == 1 && blocked == 1,
              "card import context");
      auto fixedOnly =
          chromiumLogins(root / "chromium", locked, cancelled, blocked);
      require(fixedOnly.size() == 1 && blocked == 4,
              "locked import should read v10 only");
      auto key = chromiumKey(root / "absent-local-state");
      require(key.empty(), "legacy key should be locked");
      fixedOnly = chromiumLogins(root / "chromium", key, cancelled, blocked);
      require(fixedOnly.size() == 1 && blocked == 4,
              "legacy Linux byte key imported v11");
      cancelled = true;
      fails("cancelled", [&] {
        chromiumLogins(root / "chromium", reassign, cancelled, blocked);
      });
    }
    require(fake->calls == 1, "import/list did a lookup");
    fake->error = true;
    fails("locked", [&] {
      unlockLinuxChromiumSecrets(locked.browser(), true,
                                 LinuxSecretBackend::SecretService, *fake);
    });
    fake->error = false;
    fake->secret.clear();
    fails("locked", [&] {
      unlockLinuxChromiumSecrets(locked.browser(), true,
                                 LinuxSecretBackend::SecretService, *fake);
    });
    fake->secret = Bytes{'w', 'r', 'o', 'n', 'g'};
    auto wrong = unlockLinuxChromiumSecrets(
        locked.browser(), true, LinuxSecretBackend::SecretService, *fake);
    fails("locked",
          [&] { decryptLinuxChromiumSecret(vector(vectors, "v11"), wrong); });
    // Keep a separate, already initialized internal NSS slot alive throughout
    // imports. The imported profiles have different keys and primary passwords.
    void *library = dlopen("/opt/homebrew/opt/nss/lib/libnss3.dylib",
                           RTLD_NOW | RTLD_LOCAL);
    require(library != nullptr, "fixture system NSS missing");
    auto init = reinterpret_cast<decltype(&NSS_InitContext)>(
        dlsym(library, "NSS_InitContext"));
    auto shutdown = reinterpret_cast<decltype(&NSS_ShutdownContext)>(
        dlsym(library, "NSS_ShutdownContext"));
    auto internalSlot = reinterpret_cast<decltype(&PK11_GetInternalKeySlot)>(
        dlsym(library, "PK11_GetInternalKeySlot"));
    auto freeSlot = reinterpret_cast<decltype(&PK11_FreeSlot)>(
        dlsym(library, "PK11_FreeSlot"));
    auto decrypt = reinterpret_cast<decltype(&PK11SDR_Decrypt)>(
        dlsym(library, "PK11SDR_Decrypt"));
    auto freeItem = reinterpret_cast<decltype(&SECITEM_ZfreeItem)>(
        dlsym(library, "SECITEM_ZfreeItem"));
    auto path = "sql:" + (root / "sentinel").string();
    auto *existing =
        init(path.c_str(), "", "", "", nullptr,
             NSS_INIT_READONLY | NSS_INIT_NOMODDB | NSS_INIT_NOROOTINIT);
    require(existing, "sentinel NSS context init");
    auto *slot = internalSlot();
    require(slot, "sentinel slot");
    std::atomic_bool cancelled{false};
    for (unsigned i = 0; i < 2; ++i) {
      auto rows = firefoxLogins(root / "firefox", "fixture-primary", cancelled);
      require(rows.size() == 1 && rows[0]["username"] == "fixture-user" &&
                  rows[0]["password"] == "fixture-password",
              "real NSS key4 import");
      auto other = firefoxLogins(root / "firefox-empty", "", cancelled);
      require(other.size() == 1 && other[0]["password"] == "other-password",
              "second profile NSS isolation");
      wipeJson(rows);
      wipeJson(other);
    }
    fails("locked",
          [&] { firefoxLogins(root / "firefox", "wrong-primary", cancelled); });
    auto sentinel = Json::parse(readText(root / "sentinel" / "logins.json"));
    auto bytes = decodeBase64(sentinel["logins"][0]["encryptedPassword"]);
    SECItem input{siBuffer, bytes.data(), static_cast<unsigned>(bytes.size())},
        output{};
    require(decrypt(&input, &output, nullptr) == SECSuccess,
            "import shut down or switched existing NSS");
    require(std::string(reinterpret_cast<char *>(output.data), output.len) ==
                "sentinel-password",
            "sentinel key changed");
    freeItem(&output, PR_FALSE);
    freeSlot(slot);
    shutdown(existing);
    dlclose(library);
    cancelled = true;
    fails("cancelled", [&] {
      firefoxLogins(root / "firefox", "fixture-primary", cancelled);
    });
    std::cout << "linux secret fixtures passed: CBC schemes, consent, mixed "
                 "readers, NSS real key4 and existing-slot isolation\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
