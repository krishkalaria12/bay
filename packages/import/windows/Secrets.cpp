#include "ImportCore.h"
#include "SQLite.h"
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
#include "../linux/ChromiumSecrets.h"
#include "../linux/FirefoxNSS.h"
#endif
#include <algorithm>
#include <cctype>
#include <chrono>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#ifdef _WIN32
#include <windows.h>
#endif
namespace bay::importer {
void wipeJson(Json &value) noexcept {
  if (value.is_string()) {
    auto &text = value.get_ref<std::string &>();
    volatile char *bytes = text.data();
    for (std::size_t i = 0; i < text.size(); ++i)
      bytes[i] = 0;
  } else if (value.is_array() || value.is_object())
    for (auto &child : value)
      wipeJson(child);
  value = nullptr;
}
namespace {
struct WipeSecretBytes {
  Bytes &bytes;
  ~WipeSecretBytes() { bay::sync::erase(bytes); }
};
Bytes decrypt(const Bytes &value, const Bytes &key) {
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
  // A legacy Bytes key cannot identify the Linux v11 scheme or source browser.
  // Keep old callers safe: fixed v10 only, without any desktop secret lookup.
  if (!key.empty())
    throw Failure("unsupported", "Use a source-specific Linux secret context");
  return decryptLinuxChromiumSecret(
      value, linuxChromiumSecrets(LinuxChromiumBrowser::Chromium));
#else
  if (value.size() >= 3 && value[0] == 'v' && value[1] == '2' &&
      value[2] == '0')
    throw Failure("appBound", "These secrets are protected by the source "
                              "browser. Export passwords as CSV");
  if (value.size() >= 3 && value[0] == 'v' && value[1] == '1' &&
      (value[2] == '0' || value[2] == '1')) {
    if (value.size() < 31 || key.size() != 32)
      throw Failure("locked", "Unlock the browser before importing passwords");
    return bay::sync::aesGcmOpen(key,
                                 Bytes(value.begin() + 3, value.begin() + 15),
                                 Bytes(value.begin() + 15, value.end()), {});
  }
#ifdef _WIN32
  return bay::sync::unprotect(value);
#else
  (void)key;
  throw Failure("unsupported", "DPAPI decryption requires Windows");
#endif
#endif
}
Bytes decrypt(const Bytes &value, const ChromiumSecretContext &context) {
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
  return decryptLinuxChromiumSecret(value, context);
#else
  (void)value;
  (void)context;
  throw Failure("unsupported", "Linux browser secret context requires Linux");
#endif
}
} // namespace
std::string encodeBase64(const Bytes &bytes) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (std::size_t i = 0; i < bytes.size(); i += 3) {
    std::uint32_t n = std::uint32_t(bytes[i]) << 16;
    if (i + 1 < bytes.size())
      n |= std::uint32_t(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size())
      n |= bytes[i + 2];
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += i + 1 < bytes.size() ? alphabet[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? alphabet[n & 63] : '=';
  }
  return out;
}
Bytes decodeBase64(const std::string &text) {
  static const std::string alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  Bytes out;
  unsigned buffer = 0, bits = 0;
  bool ended = false;
  for (unsigned char c : text) {
    if (c == ' ' || c == '\r' || c == '\n' || c == '\t')
      continue;
    if (c == '=') {
      ended = true;
      continue;
    }
    auto index = alphabet.find(static_cast<char>(c));
    if (index == std::string::npos || ended)
      throw Failure("format", "Invalid base64");
    buffer = (buffer << 6) | static_cast<unsigned>(index);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>(buffer >> bits));
      buffer &= (1u << bits) - 1;
    }
  }
  if (bits >= 6 || buffer != 0)
    throw Failure("format", "Invalid base64 padding");
  return out;
}
Bytes chromiumKey(const Path &root) {
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
  (void)root;
  return {}; // Legacy callers can read v10 only; no Local State or keyring
             // read.
#else
  auto data = Json::parse(readText(root / "Local State"));
  auto encrypted = decodeBase64(
      data.value("os_crypt", Json::object()).value("encrypted_key", ""));
  if (encrypted.size() < 5 ||
      !std::equal(encrypted.begin(), encrypted.begin() + 5, "DPAPI"))
    throw Failure(
        "appBound",
        "The browser does not expose a DPAPI key. Export passwords as CSV");
#ifdef _WIN32
  auto key =
      bay::sync::unprotect(Bytes(encrypted.begin() + 5, encrypted.end()));
  if (key.size() != 32) {
    bay::sync::erase(key);
    throw Failure("locked", "The browser key has an unexpected length");
  }
  return key;
#else
  throw Failure("unsupported", "DPAPI decryption requires Windows");
#endif
#endif
}
template <class Key>
Json chromiumLoginsImpl(const Path &profile, const Key &key,
                        const std::atomic_bool &cancelled, int &blocked) {
  blocked = 0;
  Json out = Json::array();
  std::set<std::string> seen;
  bool found = false;
  for (auto filename : {"Login Data", "Login Data For Account"}) {
    if (!std::filesystem::exists(profile / filename))
      continue;
    found = true;
    Snapshot db(profile / filename);
    db.query("SELECT * FROM logins", [&](sqlite3_stmt *s) {
      checkCancelled(cancelled);
      if (integer(s, "blacklisted_by_user") || integer(s, "blocked_by_user"))
        return true;
      auto encrypted = blob(s, column(s, "password_value"));
      if (encrypted.empty())
        return true;
      Bytes password;
      WipeSecretBytes wipePassword{password};
      try {
        password = decrypt(encrypted, key);
      } catch (const Failure &) {
        ++blocked;
        return true;
      }
      if (password.empty())
        return true;
      auto url = text(s, "origin_url");
      if (url.empty())
        url = text(s, "signon_realm");
      Json credential = {
          {"url", url},
          {"username", text(s, "username_value")},
          {"password", std::string(password.begin(), password.end())},
          {"realm", text(s, "signon_realm")}};
      bay::sync::erase(password);
      auto created = chromiumTime(integer(s, "date_created")),
           last = chromiumTime(integer(s, "date_last_used"));
      if (created)
        credential["created"] = created;
      if (last)
        credential["lastUsed"] = last;
      credential["timesUsed"] = integer(s, "times_used");
      auto identity = credential.value("realm", credential.value("url", "")) +
                      std::string(1, '\0') + credential.value("username", "");
      if (seen.insert(identity).second)
        out.push_back(std::move(credential));
      return true;
    });
  }
  if (!found)
    throw Failure("notFound", "No saved passwords in this profile");
  return out;
}
Json chromiumLogins(const Path &profile, const Bytes &key,
                    const std::atomic_bool &cancelled, int &blocked) {
  return chromiumLoginsImpl(profile, key, cancelled, blocked);
}
Json chromiumLogins(const Path &profile, const ChromiumSecretContext &context,
                    const std::atomic_bool &cancelled, int &blocked) {
  return chromiumLoginsImpl(profile, context, cancelled, blocked);
}
Json readEnginePasswords(const Path &root, const Path &profile) {
  if (!std::filesystem::exists(profile / "Login Data"))
    return Json::array();
  auto key = chromiumKey(root);
  std::atomic_bool cancelled{false};
  int blocked = 0;
  Json items;
  try {
    items = chromiumLogins(profile, key, cancelled, blocked);
  } catch (...) {
    bay::sync::erase(key);
    throw;
  }
  bay::sync::erase(key);
  if (blocked)
    return nullptr;
  Json out = Json::array();
  for (auto &item : items)
    out.push_back({{"origin", item.value("realm", item.value("url", ""))},
                   {"url", item["url"]},
                   {"username", item["username"]},
                   {"password", item["password"]},
                   {"created", item.value("created", 0.0)}});
  return out;
}
template <class Key>
SensitiveImport chromiumAutofillImpl(const Path &profile, const Key &key,
                                     const std::atomic_bool &cancelled,
                                     int &blocked) {
  Snapshot db(profile / "Web Data");
  SensitiveImport out;
  blocked = 0;
  std::set<std::string> seen;
  auto add = [&](const std::string &guid, Json address) {
    if (address.empty() || seen.count(guid))
      return;
    seen.insert(guid);
    if (std::find(out.addresses.begin(), out.addresses.end(), address) ==
        out.addresses.end())
      out.addresses.push_back(address);
  };
  for (auto pair : {std::pair{"addresses", "address_type_tokens"},
                    {"local_addresses", "local_addresses_type_tokens"},
                    {"contact_info", "contact_info_type_tokens"}}) {
    if (!db.table(pair.first) || !db.table(pair.second))
      continue;
    std::map<std::string, std::map<int, std::string>> values;
    db.query(std::string("SELECT guid,type,value FROM ") + pair.second,
             [&](sqlite3_stmt *s) {
               checkCancelled(cancelled);
               auto value = text(s, 2);
               if (!value.empty())
                 values[text(s, 0)][sqlite3_column_int(s, 1)] = value;
               return true;
             });
    db.query(std::string("SELECT guid FROM ") + pair.first + " ORDER BY rowid",
             [&](sqlite3_stmt *s) {
               auto guid = text(s, 0);
               auto &v = values[guid];
               Json address = Json::object();
               for (auto field : {std::pair{7, "name"},
                                  {60, "organization"},
                                  {77, "street"},
                                  {33, "city"},
                                  {34, "state"},
                                  {35, "postalCode"},
                                  {36, "country"},
                                  {14, "phone"},
                                  {9, "email"}})
                 if (!v[field.first].empty())
                   address[field.second] = v[field.first];
               if (!address.contains("name")) {
                 auto name =
                     v[3] + (!v[3].empty() && !v[5].empty() ? " " : "") + v[5];
                 if (!name.empty())
                   address["name"] = name;
               }
               if (!address.contains("street")) {
                 auto street = v[30] +
                               (!v[30].empty() && !v[31].empty() ? "\n" : "") +
                               v[31];
                 if (!street.empty())
                   address["street"] = street;
               }
               add(guid, address);
               return true;
             });
  }
  if (db.table("autofill_profiles")) {
    std::map<std::string, Json> values;
    for (auto table : {"autofill_profile_names", "autofill_profile_emails",
                       "autofill_profile_phones"})
      if (db.table(table))
        db.query(std::string("SELECT * FROM ") + table + " ORDER BY rowid",
                 [&](sqlite3_stmt *s) {
                   auto guid = text(s, "guid");
                   std::string property, value;
                   if (std::string(table) == "autofill_profile_names") {
                     property = "name";
                     value = text(s, "full_name");
                     if (value.empty()) {
                       value = text(s, "first_name");
                       for (auto part : {"middle_name", "last_name"})
                         if (!text(s, part).empty())
                           value += (value.empty() ? "" : " ") + text(s, part);
                     }
                   } else if (std::string(table) == "autofill_profile_emails") {
                     property = "email";
                     value = text(s, "email");
                   } else {
                     property = "phone";
                     value = text(s, "number");
                   }
                   if (!value.empty() && !values[guid].contains(property))
                     values[guid][property] = value;
                   return true;
                 });
    db.query("SELECT * FROM autofill_profiles ORDER BY rowid",
             [&](sqlite3_stmt *s) {
               checkCancelled(cancelled);
               auto guid = text(s, "guid");
               Json address = values[guid];
               if (address.is_null())
                 address = Json::object();
               for (auto field : {std::pair{"company_name", "organization"},
                                  {"street_address", "street"},
                                  {"city", "city"},
                                  {"state", "state"},
                                  {"zipcode", "postalCode"},
                                  {"country_code", "country"}})
                 if (!text(s, field.first).empty())
                   address[field.second] = text(s, field.first);
               if (!address.contains("street")) {
                 auto street = text(s, "address_line_1"),
                      line2 = text(s, "address_line_2");
                 if (!line2.empty())
                   street += (street.empty() ? "" : "\n") + line2;
                 if (!street.empty())
                   address["street"] = street;
               }
               add(guid, address);
               return true;
             });
  }
  if (db.table("credit_cards"))
    db.query("SELECT * FROM credit_cards", [&](sqlite3_stmt *s) {
      checkCancelled(cancelled);
      auto encrypted = blob(s, column(s, "card_number_encrypted"));
      if (encrypted.empty())
        return true;
      Bytes number;
      WipeSecretBytes wipeNumber{number};
      try {
        number = decrypt(encrypted, key);
      } catch (const Failure &) {
        ++blocked;
        return true;
      }
      auto digits = std::count_if(number.begin(), number.end(),
                                  [](auto c) { return c >= '0' && c <= '9'; });
      bool valid = std::all_of(number.begin(), number.end(), [](auto c) {
        return (c >= '0' && c <= '9') || c == ' ' || c == '-';
      });
      if (!valid || digits < 12 || digits > 19) {
        ++blocked;
        bay::sync::erase(number);
        return true;
      }
      number.erase(std::remove_if(number.begin(), number.end(),
                                  [](auto c) { return c == ' ' || c == '-'; }),
                   number.end());
      Json card = {{"number", std::string(number.begin(), number.end())}};
      bay::sync::erase(number);
      for (auto field :
           {std::pair{"name_on_card", "name"}, {"nickname", "nickname"}})
        if (!text(s, field.first).empty())
          card[field.second] = text(s, field.first);
      auto month = integer(s, "expiration_month"),
           year = integer(s, "expiration_year");
      if (month >= 1 && month <= 12)
        card["expMonth"] = month;
      if (year > 0)
        card["expYear"] = year < 100 ? 2000 + year : year;
      out.cards.push_back(card);
      return true;
    });
  return out;
}
SensitiveImport chromiumAutofill(const Path &profile, const Bytes &key,
                                 const std::atomic_bool &cancelled,
                                 int &blocked) {
  return chromiumAutofillImpl(profile, key, cancelled, blocked);
}
SensitiveImport chromiumAutofill(const Path &profile,
                                 const ChromiumSecretContext &context,
                                 const std::atomic_bool &cancelled,
                                 int &blocked) {
  return chromiumAutofillImpl(profile, context, cancelled, blocked);
}
namespace {
std::string percentDecode(const std::string &value) {
  std::string out;
  for (std::size_t i = 0; i < value.size(); ++i) {
    if (value[i] == '%' && i + 2 < value.size()) {
      auto hex = value.substr(i + 1, 2);
      if (hex.find_first_not_of("0123456789abcdefABCDEF") ==
          std::string::npos) {
        out += static_cast<char>(std::stoul(hex, nullptr, 16));
        i += 2;
        continue;
      }
    }
    out += value[i];
  }
  return out;
}
Json cookiePartition(const std::string &attributes, bool &isolated) {
  isolated = false;
  Json partition;
  auto suffix = attributes;
  if (!suffix.empty() && suffix.front() == '^')
    suffix.erase(suffix.begin());
  std::istringstream stream(suffix);
  std::string pair;
  while (std::getline(stream, pair, '&')) {
    if (pair.empty())
      continue;
    auto equal = pair.find('=');
    auto key = pair.substr(0, equal),
         value = equal == std::string::npos
                     ? ""
                     : percentDecode(pair.substr(equal + 1));
    if (key.empty()) {
      isolated = true;
      continue;
    }
    if (key == "userContextId" || key == "privateBrowsingId") {
      if (!value.empty() && value != "0")
        isolated = true;
    } else if (key == "firstPartyDomain" ||
               key == "geckoViewSessionContextId") {
      if (!value.empty())
        isolated = true;
    } else if (key == "partitionKey") {
      if (value.size() < 3 || value.front() != '(' || value.back() != ')') {
        isolated = true;
        continue;
      }
      std::vector<std::string> fields;
      std::istringstream parts(value.substr(1, value.size() - 2));
      std::string field;
      while (std::getline(parts, field, ','))
        fields.push_back(field);
      if (fields.size() < 2 || fields.size() > 3 ||
          (fields[0] != "https" && fields[0] != "http")) {
        isolated = true;
        continue;
      }
      auto host = fields[1];
      for (auto &c : host)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      bool valid =
          !host.empty() && host.front() != '.' && host.back() != '.' &&
          host.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789.-_") ==
              std::string::npos;
      if (fields.size() == 3) {
        try {
          std::size_t used = 0;
          auto port = std::stoul(fields[2], &used);
          valid =
              valid && used == fields[2].size() && port >= 1 && port <= 65535;
        } catch (...) {
          valid = false;
        }
      }
      if (!valid) {
        isolated = true;
        continue;
      }
      partition = {{"topLevelSite", fields[0] + "://" + host},
                   {"crossSite", false}};
    }
  }
  return partition;
}
} // namespace
SensitiveImport firefoxCookies(const Path &profile,
                               const std::atomic_bool &cancelled) {
  Snapshot db(profile / "cookies.sqlite");
  SensitiveImport out;
  auto now = std::chrono::duration<double, std::milli>(
                 std::chrono::system_clock::now().time_since_epoch())
                 .count();
  db.query("SELECT * FROM moz_cookies", [&](sqlite3_stmt *s) {
    checkCancelled(cancelled);
    bool isolated = false;
    auto partition = cookiePartition(text(s, "originAttributes"), isolated);
    if (isolated)
      return true;
    auto expiry = integer(s, "expiry");
    double expires =
        expiry > 100000000000LL ? static_cast<double>(expiry) : expiry * 1000.0;
    if (expires > 0 && expires < now)
      return true;
    bool secure = integer(s, "isSecure") != 0;
    auto same = integer(s, "sameSite");
    std::string sameSite = same == 1             ? "lax"
                           : same == 2           ? "strict"
                           : same == 0 && secure ? "none"
                                                 : "unspecified";
    int raw = column(s, "rawSameSite");
    if (raw >= 0 && sqlite3_column_int64(s, raw) != same)
      sameSite = "unspecified";
    auto path = text(s, "path");
    Json cookie = {{"domain", text(s, "host")},
                   {"name", text(s, "name")},
                   {"value", text(s, "value")},
                   {"path", path.empty() ? "/" : path},
                   {"secure", secure},
                   {"httpOnly", integer(s, "isHttpOnly") != 0},
                   {"sameSite", sameSite},
                   {"priority", "medium"},
                   {"sourceScheme", (integer(s, "schemeMap") & 2) ? "secure"
                                    : (integer(s, "schemeMap") & 1)
                                        ? "nonSecure"
                                        : "unset"},
                   {"sourcePort", -1}};
    if (!partition.is_null())
      cookie["partitionKey"] = partition;
    if (expires > 0)
      cookie["expires"] = expires;
    auto created = integer(s, "creationTime"),
         last = integer(s, "lastAccessed");
    if (created > 0)
      cookie["created"] = created / 1000.0;
    if (last > 0)
      cookie["lastAccess"] = last / 1000.0;
    out.cookies.push_back(cookie);
    return true;
  });
  return out;
}
#ifdef _WIN32
namespace {
std::mutex nssMutex;
struct SECItem {
  unsigned type;
  unsigned char *data;
  unsigned len;
};
class NSS {
public:
  HMODULE library = nullptr;
  int (*init)(const char *, const char *, const char *, const char *,
              std::uint32_t) = nullptr;
  int (*shutdown)() = nullptr;
  void *(*slot)() = nullptr;
  void (*freeSlot)(void *) = nullptr;
  int (*checkPassword)(void *, const char *) = nullptr;
  int (*decrypt)(SECItem *, SECItem *, void *) = nullptr;
  void (*freeItem)(SECItem *, int) = nullptr;
  bool initialized = false;
  template <class T> T function(const char *name) {
    auto f = GetProcAddress(library, name);
    if (!f)
      throw Failure("unsupported",
                    "The installed Firefox NSS library is incompatible");
    return reinterpret_cast<T>(f);
  }
  NSS() {
    for (auto variable :
         {L"ProgramW6432", L"ProgramFiles", L"ProgramFiles(x86)"}) {
      wchar_t root[32768]{};
      auto n = GetEnvironmentVariableW(variable, root, 32768);
      if (!n || n >= 32768)
        continue;
      auto path = Path(root) / L"Mozilla Firefox" / L"nss3.dll";
      library = LoadLibraryExW(path.c_str(), nullptr,
                               LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
                                   LOAD_LIBRARY_SEARCH_SYSTEM32);
      if (library)
        break;
    }
    if (!library)
      throw Failure("unsupported",
                    "Install Firefox to import encrypted Firefox passwords, or "
                    "import its password CSV export");
    try {
      init = function<decltype(init)>("NSS_Initialize");
      shutdown = function<decltype(shutdown)>("NSS_Shutdown");
      slot = function<decltype(slot)>("PK11_GetInternalKeySlot");
      freeSlot = function<decltype(freeSlot)>("PK11_FreeSlot");
      checkPassword =
          function<decltype(checkPassword)>("PK11_CheckUserPassword");
      decrypt = function<decltype(decrypt)>("PK11SDR_Decrypt");
      freeItem = function<decltype(freeItem)>("SECITEM_FreeItem");
    } catch (...) {
      FreeLibrary(library);
      library = nullptr;
      throw;
    }
  }
  ~NSS() {
    if (initialized)
      shutdown();
    if (library)
      FreeLibrary(library);
  }
  std::string field(const std::string &value) {
    auto bytes = decodeBase64(value);
    SECItem input{0, bytes.data(), static_cast<unsigned>(bytes.size())},
        output{};
    if (decrypt(&input, &output, nullptr) != 0)
      throw Failure("locked", "Firefox could not decrypt a saved login");
    std::string result(reinterpret_cast<char *>(output.data), output.len);
    SecureZeroMemory(output.data, output.len);
    freeItem(&output, 0);
    return result;
  }
};
} // namespace
Json firefoxLogins(const Path &profile, const std::string &password,
                   const std::atomic_bool &cancelled) {
  std::lock_guard<std::mutex> lock(nssMutex);
  auto temporary =
      std::filesystem::temp_directory_path() /
      std::filesystem::u8path("bay-firefox-" +
                              bay::sync::base32(bay::sync::randomBytes(16)));
  bay::sync::createPrivateDirectory(temporary);
  struct RemoveCopy {
    Path path;
    ~RemoveCopy() {
      std::error_code ignored;
      std::filesystem::remove_all(path, ignored);
    }
  } remove{temporary};
  Snapshot(profile / "key4.db").writeTo(temporary / "key4.db");
  if (std::filesystem::exists(profile / "cert9.db"))
    Snapshot(profile / "cert9.db").writeTo(temporary / "cert9.db");
  NSS nss;
  auto path = "sql:" + temporary.u8string();
  // NSS public nss.h flags: read-only, no profile modules, no root certificate
  // modules.
  constexpr std::uint32_t flags = 0x1 | 0x4 | 0x10;
  if (nss.init(path.c_str(), "", "", "secmod.db", flags) != 0)
    throw Failure("unreadable",
                  "Firefox could not open this profile's key4.db");
  nss.initialized = true;
  auto slot = nss.slot();
  if (!slot)
    throw Failure("locked", "Firefox login key is unavailable");
  int status = nss.checkPassword(slot, password.c_str());
  nss.freeSlot(slot);
  if (status != 0)
    throw Failure("locked", "Wrong Firefox primary password");
  auto json = Json::parse(readText(profile / "logins.json"));
  Json out = Json::array();
  for (auto &row : json.value("logins", Json::array())) {
    checkCancelled(cancelled);
    auto pass = nss.field(row.value("encryptedPassword", ""));
    if (pass.empty())
      continue;
    auto host = row.value("hostname", "");
    auto url = row.contains("formSubmitURL") && row["formSubmitURL"].is_string()
                   ? row["formSubmitURL"].get<std::string>()
                   : "";
    Json item = {
        {"url", url.empty() ? host : url},
        {"username", nss.field(row.value("encryptedUsername", ""))},
        {"password", pass},
        {"realm", row.contains("httpRealm") && row["httpRealm"].is_string()
                      ? row["httpRealm"]
                      : Json(host)}};
    for (auto field : {std::pair{"timeCreated", "created"},
                       {"timeLastUsed", "lastUsed"},
                       {"timesUsed", "timesUsed"}})
      if (row.contains(field.first))
        item[field.second] = row[field.first];
    out.push_back(item);
  }
  return out;
}
#elif defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
Json firefoxLogins(const Path &profile, const std::string &password,
                   const std::atomic_bool &cancelled) {
  return firefoxLoginsLinux(profile, password, cancelled);
}
#else
Json firefoxLogins(const Path &, const std::string &,
                   const std::atomic_bool &) {
  throw Failure("unsupported", "NSS password decryption is tested on Windows");
}
#endif
} // namespace bay::importer
