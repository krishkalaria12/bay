// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_RULES_H_
#define CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_RULES_H_

#include <optional>
#include <string>
#include <vector>

#include "chrome/browser/bay/webui/bay_blocker_hooks.h"

// The request filter's small decisions, as NNCoreContentBlocker.mm makes them
// on macOS: they need neither the engine nor the browser. The lists' own (their
// freshness, telling a list from an error page, the regional defaults) are
// bay-lists'.
namespace bay::content_blocker {

// The lowercased host of a URL or origin, and whether a paused site covers a
// host: bay_blocker_hooks.h's, which macOS shares.
using bay_blocker::Covers;
using bay_blocker::HostOf;
// A hiding sheet, one rule per selector so that one the engine can't parse
// drops only itself. nullopt for none.
std::optional<std::string> StyleFor(const std::vector<std::string>& selectors);

}  // namespace bay::content_blocker

#endif  // CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_RULES_H_
