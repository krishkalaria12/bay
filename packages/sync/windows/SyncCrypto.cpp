#include "SyncCrypto.h"
#include "Wordlist.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <limits>

namespace bay::sync {
namespace {
Bytes bytes(const std::string &text) { return Bytes(text.begin(), text.end()); }
Bytes hkdf(const Bytes &entropy, const std::string &info) {
  auto prk = hmac256(bytes("bay-sync/v1"), entropy);
  auto label = bytes(info);
  label.push_back(1);
  auto out = hmac256(prk, label);
  erase(prk);
  return out;
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
bool isTag(const std::string &text) {
  return text.size() == 26 &&
         text.find_first_not_of("abcdefghijklmnopqrstuvwxyz234567") ==
             std::string::npos;
}
Keys::Keys(const Bytes &entropy) {
  if (entropy.size() != 32)
    throw Failure("format", "Recovery entropy must contain 32 bytes");
  fileKey_ = hkdf(entropy, "file-key");
  nameKey_ = hkdf(entropy, "name-key");
}
Keys::~Keys() {
  erase(fileKey_);
  erase(nameKey_);
}
std::string Keys::tag(const std::string &label) const {
  auto hash = hmac256(nameKey_, bytes(label));
  hash.resize(16);
  return base32(hash);
}
std::string Keys::chainTag() const { return tag("chain"); }
std::string Keys::scopeTag(const std::string &scope) const {
  return tag("scope/" + scope);
}
Bytes Keys::aad(const std::string &scope, const std::string &id) const {
  return bytes("NNS1" + chainTag() + "/" + scope + "/" + id);
}
Bytes Keys::seal(const Bytes &payload, const std::string &scope,
                 const std::string &id) const {
  return sealWithNonce(payload, scope, id, randomBytes(12));
}
Bytes Keys::sealWithNonce(const Bytes &payload, const std::string &scope,
                          const std::string &id, const Bytes &nonce) const {
  if (payload.size() > std::numeric_limits<std::uint32_t>::max())
    throw Failure("format", "Sync payload is too large");
  auto n = static_cast<std::uint32_t>(payload.size());
  Bytes plain{static_cast<std::uint8_t>(n >> 24),
              static_cast<std::uint8_t>(n >> 16),
              static_cast<std::uint8_t>(n >> 8), static_cast<std::uint8_t>(n)};
  plain.insert(plain.end(), payload.begin(), payload.end());
  plain.resize((plain.size() + 1023) / 1024 * 1024);
  Bytes encrypted;
  try {
    encrypted = aesGcmSeal(fileKey_, nonce, plain, aad(scope, id));
  } catch (...) {
    erase(plain);
    throw;
  }
  erase(plain);
  auto out = bytes("NNS1");
  out.insert(out.end(), nonce.begin(), nonce.end());
  out.insert(out.end(), encrypted.begin(), encrypted.end());
  return out;
}
Bytes Keys::open(const Bytes &file, const std::string &scope,
                 const std::string &id) const {
  if (file.size() < 36 || !std::equal(file.begin(), file.begin() + 4, "NNS1"))
    throw Failure("format", "Invalid sync envelope");
  auto plain = aesGcmOpen(fileKey_, Bytes(file.begin() + 4, file.begin() + 16),
                          Bytes(file.begin() + 16, file.end()), aad(scope, id));
  if (plain.size() < 4) {
    erase(plain);
    throw Failure("format", "Invalid sync payload length");
  }
  std::uint32_t n = 0;
  for (unsigned i = 0; i < 4; ++i)
    n = (n << 8) | plain[i];
  if (n > plain.size() - 4) {
    erase(plain);
    throw Failure("format", "Invalid sync payload length");
  }
  Bytes result(plain.begin() + 4, plain.begin() + 4 + n);
  erase(plain);
  return result;
}
std::vector<std::string> recoveryWords(const Bytes &entropy) {
  if (entropy.size() != 32)
    throw Failure("format", "Recovery entropy must contain 32 bytes");
  auto bits = entropy;
  bits.push_back(sha256(entropy).front());
  std::vector<std::string> words;
  for (unsigned start = 0; start < 264; start += 11) {
    unsigned value = 0;
    for (unsigned j = 0; j < 11; ++j)
      value =
          (value << 1) | ((bits[(start + j) / 8] >> (7 - (start + j) % 8)) & 1);
    words.emplace_back(wordlist[value]);
  }
  erase(bits);
  return words;
}
Bytes recoveryEntropy(const std::string &phrase) {
  std::vector<std::string> tokens;
  std::string token;
  for (unsigned char c : phrase) {
    if (std::isalpha(c) && c < 128)
      token += static_cast<char>(std::tolower(c));
    else if (!token.empty()) {
      tokens.push_back(token);
      token.clear();
    }
  }
  if (!token.empty())
    tokens.push_back(token);
  if (tokens.size() != 24)
    throw Failure("wordCount", std::to_string(tokens.size()));
  Bytes combined(33);
  unsigned bit = 0;
  for (const auto &word : tokens) {
    int index = -1;
    for (unsigned i = 0; i < 2048; ++i) {
      std::string candidate(wordlist[i]);
      if (candidate == word ||
          (word.size() >= 4 && candidate.compare(0, word.size(), word) == 0)) {
        index = static_cast<int>(i);
        break;
      }
    }
    if (index < 0) {
      erase(combined);
      throw Failure("unknownWord", word);
    }
    for (int j = 10; j >= 0; --j, ++bit)
      combined[bit / 8] |= ((index >> j) & 1) << (7 - bit % 8);
  }
  Bytes entropy(combined.begin(), combined.begin() + 32);
  if (sha256(entropy).front() != combined.back()) {
    erase(entropy);
    erase(combined);
    throw Failure("checksum", "Recovery phrase checksum does not match");
  }
  erase(combined);
  return entropy;
}
} // namespace bay::sync
