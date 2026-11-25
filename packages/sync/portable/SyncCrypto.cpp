#include "SyncCrypto.h"
#include "bay_sync.h"
#include <sstream>

namespace bay::sync {
namespace {
std::string take(char *text) {
  std::string copy = text ? text : "";
  bay_sync_string_free(text);
  return copy;
}
} // namespace
void erase(Bytes &data) noexcept {
  volatile std::uint8_t *p = data.data();
  for (std::size_t i = 0; i < data.size(); ++i)
    p[i] = 0;
  data.clear();
}
std::string base32(const Bytes &input) {
  static constexpr char alphabet[] = "abcdefghijklmnopqrstuvwxyz234567";
  std::string result;
  unsigned buffer = 0, bits = 0;
  for (auto byte : input) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >> bits) & 31];
    }
    buffer &= (1u << bits) - 1;
  }
  if (bits)
    result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}
bool isTag(const std::string &text) { return bay_sync_is_tag(text.c_str()); }
Keys::Keys(const Bytes &entropy) {
  if (entropy.size() != 32)
    throw Failure("format", "Recovery entropy must contain 32 bytes");
  keys_ = bay_sync_keys_new(entropy.data());
}
Keys::~Keys() { bay_sync_keys_free(keys_); }
std::string Keys::chainTag() const { return take(bay_sync_chain_tag(keys_)); }
std::string Keys::scopeTag(const std::string &scope) const {
  return take(bay_sync_scope_tag(keys_, scope.c_str()));
}
Bytes Keys::seal(const Bytes &payload, const std::string &scope,
                 const std::string &id) const {
  return sealWithNonce(payload, scope, id, {});
}
Bytes Keys::sealWithNonce(const Bytes &payload, const std::string &scope,
                          const std::string &id, const Bytes &nonce) const {
  if (!nonce.empty() && nonce.size() != 12)
    throw Failure("format", "Invalid AES-GCM input");
  if (payload.size() > 0xffffffffu)
    throw Failure("format", "Sync payload is too large");
  std::size_t length = 0;
  std::uint8_t *sealed = bay_sync_seal_with_nonce(
      keys_, payload.data(), payload.size(), scope.c_str(), id.c_str(),
      nonce.empty() ? nullptr : nonce.data(), &length);
  Bytes out(sealed, sealed + length);
  bay_sync_bytes_free(sealed, length);
  return out;
}
Bytes Keys::open(const Bytes &file, const std::string &scope,
                 const std::string &id) const {
  std::uint8_t *payload = nullptr;
  std::size_t length = 0;
  switch (bay_sync_open(keys_, file.data(), file.size(), scope.c_str(),
                        id.c_str(), &payload, &length)) {
  case 0: {
    Bytes result(payload, payload + length);
    bay_sync_secret_free(payload, length);
    return result;
  }
  case 1:
    throw Failure("format", "Invalid sync envelope");
  default:
    throw Failure("authentication", "A sync file didn't open with this key");
  }
}
std::string newFileId() { return take(bay_sync_new_file_id()); }
std::vector<std::string> recoveryWords(const Bytes &entropy) {
  if (entropy.size() != 32)
    throw Failure("format", "Recovery entropy must contain 32 bytes");
  std::istringstream phrase(take(bay_sync_phrase_words(entropy.data())));
  std::vector<std::string> words;
  for (std::string word; phrase >> word;)
    words.push_back(word);
  return words;
}
Bytes recoveryEntropy(const std::string &phrase) {
  Bytes entropy(32);
  char *detail = nullptr;
  const int status =
      bay_sync_phrase_entropy(phrase.c_str(), entropy.data(), &detail);
  const std::string what = take(detail);
  switch (status) {
  case 0:
    return entropy;
  case 1:
    erase(entropy);
    throw Failure("wordCount", what);
  case 2:
    erase(entropy);
    throw Failure("unknownWord", what);
  default:
    erase(entropy);
    throw Failure("checksum", "Recovery phrase checksum does not match");
  }
}
} // namespace bay::sync
