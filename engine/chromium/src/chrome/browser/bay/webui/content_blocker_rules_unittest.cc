// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/content_blocker_rules.h"

#include <string>

#include "testing/gtest/include/gtest/gtest.h"

namespace bay::content_blocker {

TEST(ContentBlockerRulesTest, HostOfTakesTheLowercaseHostOfAUrlOrOrigin) {
  EXPECT_EQ(HostOf("https://WWW.Example.com:8443/a?b#c"), "www.example.com");
  EXPECT_EQ(HostOf("https://user:pw@example.com/"), "example.com");
  EXPECT_EQ(HostOf("http://[::1]:8080/"), "[::1]");
  EXPECT_EQ(HostOf("example.com"), "example.com");
  EXPECT_EQ(HostOf("about:blank"), "about");
  EXPECT_EQ(HostOf(""), "");
}

TEST(ContentBlockerRulesTest, APausedSiteCoversItsSubdomainsOnly) {
  EXPECT_TRUE(Covers("example.com", "example.com"));
  EXPECT_TRUE(Covers("example.com", "www.example.com"));
  EXPECT_FALSE(Covers("example.com", "notexample.com"));
  EXPECT_FALSE(Covers("www.example.com", "example.com"));
  EXPECT_FALSE(Covers("", "example.com"));
}

TEST(ContentBlockerRulesTest, ExpiryComesFromTheHeaderWithinItsBounds) {
  EXPECT_EQ(ExpiresAfter("! Title: x\n! Expires: 2 days (update)\n"),
            base::Days(2));
  EXPECT_EQ(ExpiresAfter("# Expires: 16 hours\n"), base::Hours(16));
  EXPECT_EQ(ExpiresAfter("! Expires: 1 hour\n"), base::Hours(12));
  EXPECT_EQ(ExpiresAfter("! Expires: 30 days\n"), base::Days(7));
  EXPECT_EQ(ExpiresAfter("||ads.example^\n"), base::Days(4));
}

TEST(ContentBlockerRulesTest, AListIsNotAnErrorPage) {
  EXPECT_TRUE(LooksLikeList("! Title: a list of rules\n"));
  EXPECT_TRUE(LooksLikeList("\xEF\xBB\xBF  ! Title: with a mark\n"));
  EXPECT_FALSE(LooksLikeList("<!doctype html><html></html>"));
  EXPECT_FALSE(LooksLikeList("  \n <html><body>503</body>"));
  EXPECT_FALSE(LooksLikeList("too short"));
  EXPECT_FALSE(LooksLikeList(std::string(33 * 1024 * 1024, '!')));
}

TEST(ContentBlockerRulesTest, RegionalListsFollowTheLanguage) {
  EXPECT_TRUE(LanguageMatches("fr nl", "fr-CA"));
  EXPECT_TRUE(LanguageMatches("pt", "pt_BR"));
  EXPECT_FALSE(LanguageMatches("fr nl", "en-GB"));
  EXPECT_FALSE(LanguageMatches("", "en"));
}

TEST(ContentBlockerRulesTest, EachSelectorIsItsOwnRule) {
  EXPECT_EQ(StyleFor({".ad", "#banner"}),
            ".ad{display:none!important}\n#banner{display:none!important}\n");
  // A brace would escape the rule.
  EXPECT_EQ(StyleFor({"a{color:red}", ".ok"}), ".ok{display:none!important}\n");
  EXPECT_EQ(StyleFor({""}), std::nullopt);
}

}  // namespace bay::content_blocker
