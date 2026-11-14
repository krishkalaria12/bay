// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/content_blocker_rules.h"

#include <algorithm>

#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "third_party/re2/src/re2/re2.h"

namespace bay::content_blocker {
namespace {
constexpr size_t kExpiresHead = 4096;
constexpr size_t kMinList = 16;
constexpr size_t kMaxList = 32 * 1024 * 1024;
}  // namespace

std::string HostOf(std::string_view url) {
  const size_t scheme = url.find("://");
  const size_t start = scheme == std::string_view::npos ? 0 : scheme + 3;
  const size_t end = url.find_first_of("/?#", start);
  std::string_view authority = url.substr(
      start, end == std::string_view::npos ? std::string_view::npos
                                           : end - start);
  const size_t at = authority.rfind('@');
  if (at != std::string_view::npos)
    authority.remove_prefix(at + 1);
  if (!authority.empty() && authority.front() == '[') {
    const size_t close = authority.find(']');
    if (close != std::string_view::npos)
      authority = authority.substr(0, close + 1);
  } else {
    authority = authority.substr(0, authority.find(':'));
  }
  return base::ToLowerASCII(authority);
}

bool Covers(std::string_view allowed, std::string_view host) {
  if (allowed.empty() || host.empty())
    return false;
  if (host == allowed)
    return true;
  return host.size() > allowed.size() && host.ends_with(allowed) &&
         host[host.size() - allowed.size() - 1] == '.';
}

base::TimeDelta ExpiresAfter(std::string_view text) {
  static const re2::LazyRE2 kExpires = {
      "(?im)^[!#]\\s*Expires:\\s*(\\d+)\\s*(h|d)"};
  std::string digits;
  std::string unit;
  if (!re2::RE2::PartialMatch(text.substr(0, kExpiresHead), *kExpires, &digits,
                              &unit)) {
    return base::Days(4);
  }
  int count = 0;
  if (!base::StringToInt(digits, &count))
    return base::Days(4);
  const base::TimeDelta after = base::EqualsCaseInsensitiveASCII(unit, "h")
                                    ? base::Hours(count)
                                    : base::Days(count);
  return std::clamp(after, base::Hours(12), base::Days(7));
}

bool LooksLikeList(std::string_view data) {
  if (data.size() < kMinList || data.size() > kMaxList)
    return false;
  // A UTF-8 byte order mark, then whitespace. Bytes, not a decoded prefix: a
  // prefix can end inside a multibyte character.
  if (data.starts_with("\xEF\xBB\xBF"))
    data.remove_prefix(3);
  while (!data.empty() && base::IsAsciiWhitespace(data.front()))
    data.remove_prefix(1);
  return !data.empty() && data.front() != '<';
}

bool LanguageMatches(std::string_view codes, std::string_view locale) {
  const std::string language = base::ToLowerASCII(
      locale.substr(0, locale.find_first_of("-_")));
  if (language.empty())
    return false;
  const auto list = base::SplitStringPiece(codes, " ", base::TRIM_WHITESPACE,
                                           base::SPLIT_WANT_NONEMPTY);
  return std::ranges::find(list, language) != list.end();
}

std::optional<std::string> StyleFor(const std::vector<std::string>& selectors) {
  std::string css;
  for (const auto& selector : selectors) {
    if (selector.empty() || selector.find_first_of("{}") != std::string::npos)
      continue;
    css += selector + "{display:none!important}\n";
  }
  if (css.empty())
    return std::nullopt;
  return css;
}

}  // namespace bay::content_blocker
