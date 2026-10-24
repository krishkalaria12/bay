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
std::map<std::string, std::string> secrets;
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
                               const char *value, void *, GError **error, ...) {
  va_list args;
  va_start(args, error);
  auto key = secretKey(args);
  va_end(args);
  if (!available) {
    *error = new GError;
    return 0;
  }
  secrets[key] = value;
  return 1;
}
char *secret_password_lookup_sync(const SecretSchema *, void *, GError **error,
                                  ...) {
  va_list args;
  va_start(args, error);
  auto key = secretKey(args);
  va_end(args);
  if (!available) {
    *error = new GError;
    return nullptr;
  }
  if (!secrets.count(key))
    return nullptr;
  return ::strdup(secrets[key].c_str());
}
int secret_password_clear_sync(const SecretSchema *, void *, GError **error,
                               ...) {
  va_list args;
  va_start(args, error);
  auto key = secretKey(args);
  va_end(args);
  if (!available) {
    *error = new GError;
    return 0;
  }
  secrets.erase(key);
  return 1;
}
void secret_password_free(char *value) { std::free(value); }
void g_error_free(GError *value) { delete value; }
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
  std::cout << "Service session fallback, account isolation, recovery, and "
               "persistent key checks passed\n";
}
