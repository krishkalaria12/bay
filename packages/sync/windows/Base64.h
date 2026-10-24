#pragma once
#include "SyncCrypto.h"

namespace bay::sync {
// Same encoding as importer Secrets.cpp; sync links independently of import.
inline std::string encodeBase64(const Bytes &bytes) {
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
inline Bytes decodeBase64(const std::string &text) {
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
} // namespace bay::sync
