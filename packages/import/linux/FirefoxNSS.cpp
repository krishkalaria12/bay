#include "FirefoxNSS.h"
#include "../windows/SQLite.h"
#include "SystemLibrary.h"
#include <limits>
#include <mutex>
#include <nss.h>
#include <pk11pub.h>
#include <secitem.h>
namespace bay::importer {
namespace {
std::mutex importNSSMutex;
struct WipeBytes {
  Bytes &value;
  ~WipeBytes() { bay::sync::erase(value); }
};
struct WipeString {
  std::string &value;
  ~WipeString() {
    volatile char *p = value.data();
    for (std::size_t i = 0; i < value.size(); ++i)
      p[i] = 0;
  }
};
// Strict, bounded DER reader for NSS SDRResult: key id, AlgorithmIdentifier,
// ciphertext. Unknown algorithms and non-minimal/trailing encodings fail
// closed.
class DER {
  const unsigned char *p_;
  std::size_t size_;

public:
  DER(const unsigned char *p, std::size_t size) : p_(p), size_(size) {}
  explicit DER(const Bytes &b) : DER(b.data(), b.size()) {}
  bool empty() const { return size_ == 0; }
  DER field(unsigned tag) {
    if (size_ < 2 || p_[0] != tag)
      throw Failure("format", "Invalid Firefox login envelope");
    std::size_t head = 2, length = p_[1];
    if (length & 0x80) {
      auto count = length & 0x7f;
      if (!count || count > sizeof(std::size_t) || count > size_ - 2 || !p_[2])
        throw Failure("format", "Invalid Firefox DER length");
      length = 0;
      for (std::size_t i = 0; i < count; ++i) {
        if (length > (std::numeric_limits<std::size_t>::max() >> 8))
          throw Failure("format", "Invalid Firefox DER length");
        length = (length << 8) | p_[2 + i];
      }
      if (length < 128)
        throw Failure("format", "Non-minimal Firefox DER length");
      head += count;
    }
    if (length > size_ - head)
      throw Failure("format", "Truncated Firefox login envelope");
    DER result(p_ + head, length);
    p_ += head + length;
    size_ -= head + length;
    return result;
  }
  Bytes bytes() const { return Bytes(p_, p_ + size_); }
};
class ProfileNSS {
  void *library_ = nullptr;
  NSSInitContext *context_ = nullptr;
  PK11SlotInfo *slot_ = nullptr;
  template <class T> T function(const char *name) {
    auto f = dlsym(library_, name);
    if (!f)
      throw Failure("unsupported", "The system NSS library is incompatible");
    return reinterpret_cast<T>(f);
  }
#define NSS_FUNCTION(name) decltype(&name) name##_ = nullptr
  NSS_FUNCTION(NSS_InitContext);
  NSS_FUNCTION(NSS_ShutdownContext);
  NSS_FUNCTION(SECMOD_OpenUserDB);
  NSS_FUNCTION(SECMOD_CloseUserDB);
  NSS_FUNCTION(PK11_FreeSlot);
  NSS_FUNCTION(PK11_CheckUserPassword);
  NSS_FUNCTION(PK11_FindFixedKey);
  NSS_FUNCTION(PK11_FreeSymKey);
  NSS_FUNCTION(PK11_GetKeyLength);
  NSS_FUNCTION(PK11_Decrypt);
#undef NSS_FUNCTION
  void close() noexcept {
    if (slot_) {
      SECMOD_CloseUserDB_(slot_);
      PK11_FreeSlot_(slot_);
      slot_ = nullptr;
    }
    // Release only our initialization reference, never NSS_Shutdown(). NSS
    // contexts share process state, so decryption always uses slot_ above.
    if (context_) {
      NSS_ShutdownContext_(context_);
      context_ = nullptr;
    }
    if (library_) {
      dlclose(library_);
      library_ = nullptr;
    }
  }

public:
  explicit ProfileNSS(const Path &database) {
#if defined(__APPLE__) && defined(BAY_IMPORT_LINUX_TEST)
    // Fixture-only Mac path. Production Linux never accepts a library path
    // supplied by a profile, environment variable, or service argument.
    library_ = dlopen("/opt/homebrew/opt/nss/lib/libnss3.dylib",
                      RTLD_NOW | RTLD_LOCAL);
#else
    library_ = linux_secrets::openSystemLibrary(
        {"/usr/lib/x86_64-linux-gnu/libnss3.so", "/usr/lib64/libnss3.so",
         "/usr/lib/libnss3.so", "/usr/lib/aarch64-linux-gnu/libnss3.so"});
#endif
    if (!library_)
      throw Failure("unsupported", "Install system NSS to import Firefox "
                                   "passwords, or import a CSV export");
    try {
#define NSS_LOAD(name) name##_ = function<decltype(name##_)>(#name)
      NSS_LOAD(NSS_InitContext);
      NSS_LOAD(NSS_ShutdownContext);
      NSS_LOAD(SECMOD_OpenUserDB);
      NSS_LOAD(SECMOD_CloseUserDB);
      NSS_LOAD(PK11_FreeSlot);
      NSS_LOAD(PK11_CheckUserPassword);
      NSS_LOAD(PK11_FindFixedKey);
      NSS_LOAD(PK11_FreeSymKey);
      NSS_LOAD(PK11_GetKeyLength);
      NSS_LOAD(PK11_Decrypt);
#undef NSS_LOAD
      context_ = NSS_InitContext_("", "", "", "", nullptr,
                                  NSS_INIT_READONLY | NSS_INIT_NOCERTDB |
                                      NSS_INIT_NOMODDB | NSS_INIT_NOROOTINIT |
                                      NSS_INIT_COOPERATE);
      if (!context_)
        throw Failure("unreadable", "Could not initialize system NSS");
      auto path = database.u8string();
      if (path.find_first_of("'\\") != std::string::npos)
        throw Failure("unsupported",
                      "The temporary database path cannot be used with NSS");
      auto specification = "configDir='sql:" + path +
                           "' tokenDescription='Bay Firefox import " +
                           database.filename().u8string() + "' flags=readOnly";
      slot_ = SECMOD_OpenUserDB_(specification.c_str());
      if (!slot_)
        throw Failure("unreadable",
                      "Firefox could not open this profile's key4.db");
    } catch (...) {
      close();
      throw;
    }
  }
  ~ProfileNSS() { close(); }
  void unlock(const std::string &password) {
    if (password.find('\0') != std::string::npos ||
        PK11_CheckUserPassword_(slot_, password.c_str()) != SECSuccess)
      throw Failure("locked", "Wrong Firefox primary password");
  }
  std::string field(const std::string &text) {
    auto encoded = decodeBase64(text);
    DER input(encoded);
    auto sequence = input.field(0x30);
    if (!input.empty())
      throw Failure("format", "Trailing Firefox login data");
    auto keyID = sequence.field(0x04).bytes();
    auto algorithm = sequence.field(0x30);
    auto oid = algorithm.field(0x06).bytes();
    auto iv = algorithm.field(0x04).bytes();
    auto encrypted = sequence.field(0x04).bytes();
    if (!algorithm.empty() || !sequence.empty() || keyID.empty() ||
        encrypted.empty() ||
        keyID.size() > std::numeric_limits<unsigned>::max() ||
        encrypted.size() > std::numeric_limits<unsigned>::max())
      throw Failure("format", "Invalid Firefox login envelope");
    CK_MECHANISM_TYPE mechanism, padded;
    unsigned keyLength = 0;
    if (oid == Bytes{0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x03, 0x07}) {
      mechanism = CKM_DES3_CBC;
      padded = CKM_DES3_CBC_PAD;
      keyLength = 24;
      if (iv.size() != 8 || encrypted.size() % 8)
        throw Failure("format", "Invalid Firefox 3DES envelope");
    } else if (oid.size() == 9 &&
               std::equal(oid.begin(), oid.begin() + 8,
                          Bytes{0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01}
                              .begin()) &&
               (oid[8] == 2 || oid[8] == 22 || oid[8] == 42)) {
      mechanism = CKM_AES_CBC;
      padded = CKM_AES_CBC_PAD;
      keyLength = oid[8] == 2 ? 16 : oid[8] == 22 ? 24 : 32;
      if (iv.size() != 16 || encrypted.size() % 16)
        throw Failure("format", "Invalid Firefox AES envelope");
    } else
      throw Failure("unsupported",
                    "Unsupported Firefox login encryption algorithm");
    SECItem id{siBuffer, keyID.data(), static_cast<unsigned>(keyID.size())};
    auto *key = PK11_FindFixedKey_(slot_, mechanism, &id, nullptr);
    if (!key)
      throw Failure("locked", "Firefox login key is unavailable");
    struct FreeKey {
      PK11SymKey *p;
      decltype(PK11_FreeSymKey_) free;
      ~FreeKey() { free(p); }
    } freeKey{key, PK11_FreeSymKey_};
    if (PK11_GetKeyLength_(key) != keyLength)
      throw Failure("format", "Unexpected Firefox login key length");
    SECItem parameter{siBuffer, iv.data(), static_cast<unsigned>(iv.size())};
    Bytes plain(encrypted.size());
    WipeBytes wipe{plain};
    unsigned length = 0;
    if (PK11_Decrypt_(key, padded, &parameter, plain.data(), &length,
                      static_cast<unsigned>(plain.size()), encrypted.data(),
                      static_cast<unsigned>(encrypted.size())) != SECSuccess ||
        length > plain.size())
      throw Failure("locked", "Firefox could not decrypt a saved login");
    return std::string(plain.begin(), plain.begin() + length);
  }
};
} // namespace
Json firefoxLoginsLinux(const Path &profile, const std::string &password,
                        const std::atomic_bool &cancelled) {
  std::lock_guard<std::mutex> lock(importNSSMutex);
  checkCancelled(cancelled);
  auto temporary =
      std::filesystem::temp_directory_path() /
      std::filesystem::u8path("bay-firefox-" +
                              bay::sync::base32(bay::sync::randomBytes(16)));
  bay::sync::createPrivateDirectory(temporary);
  struct Remove {
    Path p;
    ~Remove() {
      std::error_code ignored;
      std::filesystem::remove_all(p, ignored);
    }
  } remove{temporary};
  Snapshot(profile / "key4.db").writeTo(temporary / "key4.db");
  if (std::filesystem::exists(profile / "cert9.db"))
    Snapshot(profile / "cert9.db").writeTo(temporary / "cert9.db");
  ProfileNSS nss(temporary);
  nss.unlock(password);
  auto document = Json::parse(readText(profile / "logins.json"));
  Json out = Json::array();
  try {
    for (auto &row : document.value("logins", Json::array())) {
      checkCancelled(cancelled);
      auto pass = nss.field(row.value("encryptedPassword", ""));
      WipeString wipePass{pass};
      if (pass.empty())
        continue;
      auto username = nss.field(row.value("encryptedUsername", ""));
      WipeString wipeUsername{username};
      auto host = row.value("hostname", "");
      auto url =
          row.contains("formSubmitURL") && row["formSubmitURL"].is_string()
              ? row["formSubmitURL"].get<std::string>()
              : "";
      Json item = {
          {"url", url.empty() ? host : url},
          {"username", username},
          {"password", pass},
          {"realm", row.contains("httpRealm") && row["httpRealm"].is_string()
                        ? row["httpRealm"]
                        : Json(host)}};
      for (auto pair : {std::pair{"timeCreated", "created"},
                        {"timeLastUsed", "lastUsed"},
                        {"timesUsed", "timesUsed"}})
        if (row.contains(pair.first))
          item[pair.second] = row[pair.first];
      out.push_back(std::move(item));
    }
    return out;
  } catch (...) {
    wipeJson(out);
    throw;
  }
}
} // namespace bay::importer
