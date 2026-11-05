// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_NN_SEARCH_SUGGESTIONS_POLICY_H_
#define CHROME_BROWSER_BAY_NN_SEARCH_SUGGESTIONS_POLICY_H_

#include "url/gurl.h"

namespace bay {
bool MatchesSuggestionEndpoint(const GURL& request, const GURL& endpoint);
bool IsBuiltInSuggestionEndpoint(const GURL& request);
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_NN_SEARCH_SUGGESTIONS_POLICY_H_
