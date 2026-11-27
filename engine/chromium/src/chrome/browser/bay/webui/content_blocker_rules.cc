// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/content_blocker_rules.h"

namespace bay::content_blocker {

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
