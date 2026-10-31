// Portable service check: real crypto/vault/service, fake desktop/keyring
// edges.
#include "../../windows/RecoveryKit.h"
#include "../../windows/SyncService.h"
#include <cassert>
#include <cstdarg>
#include <cstring>
#include <fstream>
#include <iostream>
#include <libsecret/secret.h>
#include <map>
#include <nlohmann/json.hpp>

namespace {
bool available = false;
struct Secret {
  std::string value;
  bool locked = false;
};
std::multimap<std::string, Secret> secrets;
bool allowUnlock = true;
bool searchError = false;
bool deleteError = false;
bool allowDelete = true;
std::vector<std::string> unlockRequests;
void serviceError(GError **error) {
  g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                      "Fake Secret Service failure");
}
std::string secretKey(va_list args) {
  std::string account, profile;
  while (const char *name = va_arg(args, const char *)) {
    auto value = va_arg(args, const char *);
    if (std::string(name) == "account")
      account = value;
    if (std::string(name) == "profile")
      profile = value;
  }
  return profile + ":" + account;
}
} // namespace
extern "C" {
int secret_password_store_sync(const SecretSchema *, const char *, const char *,
                               const char *value, GCancellable *,
                               GError **error, ...) {
  va_list args;
  va_start(args, error);
  auto key = secretKey(args);
  va_end(args);
  if (!available) {
    serviceError(error);
    return 0;
  }
  secrets.erase(key);
  secrets.emplace(key, Secret{value});
  return 1;
}
char *secret_password_lookup_sync(const SecretSchema *, GCancellable *,
                                  GError **error, ...) {
  va_list args;
  va_start(args, error);
  auto key = secretKey(args);
  va_end(args);
  if (!available) {
    serviceError(error);
    return nullptr;
  }
  auto matches = secrets.equal_range(key);
  for (auto it = matches.first; it != matches.second; ++it) {
    if (!it->second.locked)
      return ::strdup(it->second.value.c_str());
  }
  return nullptr;
}
int secret_password_clear_sync(const SecretSchema *, GCancellable *,
                               GError **error, ...) {
  va_list args;
  va_start(args, error);
  auto key = secretKey(args);
  va_end(args);
  if (!available) {
    serviceError(error);
    return 0;
  }
  // Like libsecret clear_sync, silently skip locked matches.
  bool removed = false;
  auto matches = secrets.equal_range(key);
  for (auto it = matches.first; it != matches.second;) {
    if (it->second.locked) {
      ++it;
    } else {
      it = secrets.erase(it);
      removed = true;
    }
  }
  return removed;
}
GHashTable *secret_attributes_build(const SecretSchema *schema, ...) {
  assert(std::string(schema->name) == "app.bay.SyncKey");
  auto *attributes =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  va_list args;
  va_start(args, schema);
  while (const char *name = va_arg(args, const char *)) {
    auto *value = va_arg(args, const char *);
    g_hash_table_insert(attributes, g_strdup(name), g_strdup(value));
  }
  va_end(args);
  return attributes;
}
GList *secret_service_search_sync(SecretService *, const SecretSchema *schema,
                                  GHashTable *attributes,
                                  SecretSearchFlags flags, GCancellable *,
                                  GError **error) {
  assert(std::string(schema->name) == "app.bay.SyncKey");
  assert(!(flags & SECRET_SEARCH_LOAD_SECRETS));
  assert(g_hash_table_size(attributes) == 2);
  const auto *account =
      static_cast<const char *>(g_hash_table_lookup(attributes, "account"));
  const auto *profile =
      static_cast<const char *>(g_hash_table_lookup(attributes, "profile"));
  assert(account && profile);
  if (!available || searchError) {
    serviceError(error);
    return nullptr;
  }
  auto matches = secrets.equal_range(std::string(profile) + ":" + account);
  GList *items = nullptr;
  for (auto it = matches.first; it != matches.second; ++it) {
    if (it->second.locked && (flags & SECRET_SEARCH_UNLOCK)) {
      unlockRequests.push_back(it->first);
      if (allowUnlock)
        it->second.locked = false;
      // libsecret returns still-locked matches without a search error on
      // denial.
    }
    auto *item = G_OBJECT(g_object_new(G_TYPE_OBJECT, nullptr));
    g_object_set_data(item, "secret", &it->second);
    items = g_list_append(items, item);
    if (!(flags & SECRET_SEARCH_ALL))
      break;
  }
  return items;
}
gboolean secret_item_get_locked(SecretItem *item) {
  return static_cast<Secret *>(g_object_get_data(item, "secret"))->locked;
}
gboolean secret_item_delete_sync(SecretItem *item, GCancellable *,
                                 GError **error) {
  if (deleteError) {
    serviceError(error);
    return false;
  }
  if (!allowDelete || secret_item_get_locked(item))
    return false;
  auto *secret = g_object_get_data(item, "secret");
  for (auto it = secrets.begin(); it != secrets.end(); ++it) {
    if (&it->second == secret) {
      secrets.erase(it);
      return true;
    }
  }
  assert(false);
  return false;
}
void secret_password_free(char *value) { std::free(value); }
}
namespace bay::sync {
Bytes recoveryKitPreviewPNG(const Bytes &, const std::string &, unsigned) {
  return {};
}
std::filesystem::path temporaryRecoveryKit(const Bytes &, const std::string &,
                                           const std::filesystem::path &) {
  return {};
}
void copyRecoveryKitFile(const std::filesystem::path &) {}
void copyRecoveryPhraseText(const std::string &) {}
void revealSyncFolder(const std::filesystem::path &) {}
void writeRecoveryKitFile(const std::filesystem::path &path,
                          const std::string &content) {
  std::ofstream file(path, std::ios::binary);
  file << content;
  if (!file)
    throw Failure("save", "test write failed");
}
} // namespace bay::sync

int main(int argc, char **argv) {
  assert(argc == 2);
  using namespace bay::sync;
  using Json = nlohmann::json;
  auto call = [](const char *method, Json args = Json::array()) {
    auto envelope = Json::parse(InvokeEnvelope(method, args.dump()));
    if (envelope.contains("error"))
      throw std::runtime_error(envelope.dump());
    return envelope.at("value");
  };
  std::filesystem::path directory(argv[1]);
  auto first = (directory / "first").string();
  auto second = (directory / "second").string();
  auto chain = (directory / "chain").string();
  SetDataDirectory(first);
  assert(!call("unlock", {"a"}).get<bool>());
  assert(call("folderInfo")["keyStorage"] == "locked");
  assert(call("createPhrase", {"a"}) == true);
  assert(secrets.empty());
  assert(call("folderInfo")["keyStorage"] == "session");
  auto words = call("recoveryWords").get<std::vector<std::string>>();
  assert(words.size() == 24);
  const auto exported = directory / "recovery.txt";
  auto savedKit = Json::parse(SaveRecoveryKitToPath("text", exported.string(),
                                                    RecoveryKeyGeneration()));
  assert(savedKit["value"] == exported.string());
  std::ifstream exportedFile(exported);
  std::string exportedText((std::istreambuf_iterator<char>(exportedFile)), {});
  for (const auto &word : words)
    assert(exportedText.find(word) != std::string::npos);
  assert(Json::parse(InvokeEnvelope("saveRecoveryKitToPath",
                                    "[]"))["error"]["code"] == "unsupported");
  assert(Json::parse(SaveRecoveryKitToPath(
             "bad", exported.string(),
             RecoveryKeyGeneration()))["error"]["code"] == "invalid_arguments");
  std::string phrase;
  for (const auto &word : words) {
    if (!phrase.empty())
      phrase += ' ';
    phrase += word;
  }
  assert(call("unlock", {"a"}) == true);
  assert(call("recoveryWords") == words);
  call("createChain", {chain});
  auto ciphertext = call("sealLocal", {"private"});
  assert(call("openLocal", {ciphertext}) == "private");
  assert(call("unlock", {"b"}) == false);
  assert(call("folderInfo")["keyStorage"] == "locked");
  assert(Json::parse(InvokeEnvelope("recoveryWords", "[]"))["error"]["code"] ==
         "locked");
  assert(call("openLocal", {ciphertext}).is_null());
  assert(Json::parse(SaveRecoveryKitToPath(
             "pdf", (directory / "locked.pdf").string(),
             RecoveryKeyGeneration()))["error"]["code"] == "locked");
  assert(!std::filesystem::exists(directory / "locked.pdf"));
  assert(call("enterPhrase", {"a", phrase, chain})["ok"] == true);
  assert(call("folderInfo")["keyStorage"] == "session");
  assert(call("openLocal", {ciphertext}) == "private");
  // Changing the configured profile simulates losing process-only entropy.
  SetDataDirectory(second);
  SetDataDirectory(first);
  assert(call("unlock", {"a"}) == false);
  assert(call("enterPhrase", {"a", phrase, chain})["ok"] == true);
  call("forget", {"a"});
  assert(call("folderInfo")["keyStorage"] == "locked");
  assert(call("unlock", {"a"}) == false);
  // A dialog opened for one key must never export a replacement account key.
  assert(call("createPhrase", {"a"}) == true);
  auto oldGeneration = RecoveryKeyGeneration();
  assert(oldGeneration != 0);
  assert(call("createPhrase", {"b"}) == true);
  auto staleTarget = directory / "stale.pdf";
  auto staleSave = Json::parse(
      SaveRecoveryKitToPath("pdf", staleTarget.string(), oldGeneration));
  assert(staleSave.contains("error"));
  assert(!std::filesystem::exists(staleTarget));
  call("forget", {"b"});
  available = true;
  assert(call("createPhrase", {"a"}) == true);
  assert(call("folderInfo")["keyStorage"] == "persistent");
  auto persistedWords = call("recoveryWords");
  SetDataDirectory(second);
  assert(call("unlock", {"a"}) == false);
  SetDataDirectory(first);
  assert(call("unlock", {"a"}) == true);
  assert(call("recoveryWords") == persistedWords);
  call("forget", {"a"});
  assert(secrets.empty());
  assert(call("unlock", {"a"}) == false);
  // Already-forgotten accounts succeed without requesting any unlock.
  auto unlockCount = unlockRequests.size();
  call("forget", {"missing"});
  assert(unlockRequests.size() == unlockCount);

  // A locked stored key must either be deleted or produce a keychain error.
  assert(call("createPhrase", {"a"}) == true);
  const auto key = first + ":a";
  secrets.find(key)->second.locked = true;
  allowUnlock = false;
  auto denied = Json::parse(InvokeEnvelope("forget", "[\"a\"]"));
  assert(denied["error"]["code"] == "keychain");
  assert(call("folderInfo")["keyStorage"] == "locked");
  assert(secrets.count(key) == 1);
  assert(!loadSecret("a"));
  secrets.find(key)->second.locked = false;
  assert(loadSecret("a")); // The refusal must not have claimed revocation.

  // Both a false return without GError and a service error must propagate.
  allowDelete = false;
  assert(Json::parse(InvokeEnvelope("forget", "[\"a\"]"))["error"]["code"] ==
         "keychain");
  assert(loadSecret("a"));
  allowDelete = true;
  deleteError = true;
  assert(Json::parse(InvokeEnvelope("forget", "[\"a\"]"))["error"]["code"] ==
         "keychain");
  assert(loadSecret("a"));
  deleteError = false;
  searchError = true;
  assert(Json::parse(InvokeEnvelope("forget", "[\"a\"]"))["error"]["code"] ==
         "keychain");
  assert(loadSecret("a"));
  searchError = false;
  available = false;
  assert(Json::parse(InvokeEnvelope("forget", "[\"a\"]"))["error"]["code"] ==
         "keychain");
  available = true;

  // Remove all matching duplicates, including locked ones, without touching
  // another account or profile or loading any secret during the search.
  const auto saved = secrets.find(key)->second.value;
  secrets.find(key)->second.locked = true;
  secrets.emplace(key, Secret{saved});
  secrets.emplace(first + ":b", Secret{saved, true});
  secrets.emplace(second + ":a", Secret{saved, true});
  allowUnlock = true;
  unlockRequests.clear();
  call("forget", {"a"});
  assert(secrets.count(key) == 0);
  assert(unlockRequests == std::vector<std::string>{key});
  assert(secrets.find(first + ":b")->second.locked);
  assert(secrets.find(second + ":a")->second.locked);
  for (auto &entry : secrets)
    entry.second.locked = false;
  assert(!loadSecret("a"));
  assert(call("unlock", {"a"}) == false);
  assert(loadSecret("b"));
  SetDataDirectory(second);
  assert(loadSecret("a"));
  std::cout << "Service session fallback, account isolation, recovery, and "
               "persistent key revocation checks passed\n";
}
