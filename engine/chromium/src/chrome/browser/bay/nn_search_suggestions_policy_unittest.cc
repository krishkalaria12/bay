// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_search_suggestions_policy.h"

#include <string>

#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
TEST(SearchSuggestionsPolicy, BuiltInEndpointsAreExactAndCookieFreeHttpsOnly) {
  EXPECT_TRUE(IsBuiltInSuggestionEndpoint(GURL(
      "https://suggestqueries.google.com/complete/search?client=firefox&q=bay")));
  EXPECT_TRUE(IsBuiltInSuggestionEndpoint(
      GURL("https://api.bing.com/osjson.aspx?query=bay")));
  EXPECT_TRUE(IsBuiltInSuggestionEndpoint(
      GURL("https://duckduckgo.com/ac/?q=bay&type=list")));
  for (const char* denied : {
           "http://suggestqueries.google.com/complete/search?q=bay",
           "https://suggestqueries.google.com.evil/complete/search?q=bay",
           "https://suggestqueries.google.com:444/complete/search?q=bay",
           "https://suggestqueries.google.com/other?q=bay",
           "https://user:password@suggestqueries.google.com/complete/search",
           "https://suggestqueries.google.com/complete/search?q=bay#fragment",
           "https://127.0.0.1/complete/search?q=bay",
           "file:///etc/passwd"}) {
    EXPECT_FALSE(IsBuiltInSuggestionEndpoint(GURL(denied))) << denied;
  }
}

TEST(SearchSuggestionsPolicy, ExtensionEndpointDoesNotGrantOtherPathsOrOrigins) {
  const GURL endpoint("https://search.example/suggest?q=%s");
  EXPECT_TRUE(MatchesSuggestionEndpoint(
      GURL("https://search.example/suggest?q=bay"), endpoint));
  EXPECT_FALSE(MatchesSuggestionEndpoint(
      GURL("https://search.example/private?q=bay"), endpoint));
  EXPECT_FALSE(MatchesSuggestionEndpoint(
      GURL("https://search.example.evil/suggest?q=bay"), endpoint));
  EXPECT_FALSE(MatchesSuggestionEndpoint(
      GURL("https://search.example:444/suggest?q=bay"), endpoint));
  EXPECT_FALSE(MatchesSuggestionEndpoint(
      GURL("https://search.example/suggest?q=bay"),
      GURL("http://search.example/suggest?q=%s")));
}

TEST(SearchSuggestionsPolicy, OversizedRequestsAreRejected) {
  EXPECT_FALSE(IsBuiltInSuggestionEndpoint(GURL(
      "https://suggestqueries.google.com/complete/search?q=" +
      std::string(8192, 'x'))));
}
}  // namespace bay
