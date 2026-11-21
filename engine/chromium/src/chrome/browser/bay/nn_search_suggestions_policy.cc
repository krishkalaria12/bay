// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_search_suggestions_policy.h"

namespace bay {
bool MatchesSuggestionEndpoint(const GURL& request, const GURL& endpoint) {
  return request.is_valid() && endpoint.is_valid() &&
         request.SchemeIs("https") && endpoint.SchemeIs("https") &&
         !request.has_username() && !request.has_password() &&
         !request.has_ref() && request.spec().size() <= 8192 &&
         request.host() == endpoint.host() &&
         request.EffectiveIntPort() == endpoint.EffectiveIntPort() &&
         request.path() == endpoint.path();
}

bool IsBuiltInSuggestionEndpoint(const GURL& request) {
  // These are the suggestion endpoints of packages/core/src/engines.ts.
  for (const char* endpoint : {
           "https://suggestqueries.google.com/complete/search",
           "https://api.bing.com/osjson.aspx",
           "https://duckduckgo.com/ac/",
           "https://ac.ecosia.org/autocomplete",
           "https://search.brave.com/api/suggest",
           "https://www.startpage.com/osuggestions",
           "https://search.yahoo.com/sugg/ff",
           "https://www.baidu.com/su",
           "https://suggest.yandex.com/suggest-ff.cgi"}) {
    if (MatchesSuggestionEndpoint(request, GURL(endpoint)))
      return true;
  }
  return false;
}

}  // namespace bay
