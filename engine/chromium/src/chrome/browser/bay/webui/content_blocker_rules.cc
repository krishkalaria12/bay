// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/content_blocker_rules.h"

#include "base/strings/string_util.h"

namespace bay::content_blocker {

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
