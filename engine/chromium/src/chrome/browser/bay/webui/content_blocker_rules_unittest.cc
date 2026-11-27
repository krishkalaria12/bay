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

TEST(ContentBlockerRulesTest, EachSelectorIsItsOwnRule) {
  EXPECT_EQ(StyleFor({".ad", "#banner"}),
            ".ad{display:none!important}\n#banner{display:none!important}\n");
  // A brace would escape the rule.
  EXPECT_EQ(StyleFor({"a{color:red}", ".ok"}), ".ok{display:none!important}\n");
  EXPECT_EQ(StyleFor({""}), std::nullopt);
}

}  // namespace bay::content_blocker
