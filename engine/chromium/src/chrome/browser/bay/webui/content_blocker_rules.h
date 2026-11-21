// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_RULES_H_
#define CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_RULES_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/time/time.h"

// The content blocker's small decisions, as NNCoreContentBlocker.mm makes them
// on macOS: they need neither the engine nor the browser.
namespace bay::content_blocker {

// The lowercased host of a URL or origin ("" when it has none).
std::string HostOf(std::string_view url);
// A paused site covers its subdomains: "example.com" covers "www.example.com".
bool Covers(std::string_view allowed, std::string_view host);
// How long a list stays fresh, from its `! Expires: 4 days (update frequency)`
// header: 12 hours to a week, else 4 days.
base::TimeDelta ExpiresAfter(std::string_view text);
// A filter list, not an error page: text that doesn't start like HTML.
bool LooksLikeList(std::string_view data);
// On by default for one of the user's languages: `codes` is the catalogue's
// space-separated list, `locale` a BCP 47 tag.
bool LanguageMatches(std::string_view codes, std::string_view locale);
// A hiding sheet, one rule per selector so that one the engine can't parse
// drops only itself. nullopt for none.
std::optional<std::string> StyleFor(const std::vector<std::string>& selectors);

}  // namespace bay::content_blocker

#endif  // CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_RULES_H_
