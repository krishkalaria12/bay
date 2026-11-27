// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_APP_LINK_THROTTLE_H_
#define BAY_MOBILE_BROWSER_BAY_APP_LINK_THROTTLE_H_

#include "content/public/browser/navigation_throttle.h"

namespace bay {

// Open app links in (C19), as iOS does with universal links: a link the person taps in a page, to another site, goes
// to the app that claims it when one does (the app answers through BayTab.openAppLink, which also knows whether the
// person wants that), and the tab stays where it was. Typed addresses, redirects, history and links within the site
// always load in the tab.
class BayAppLinkThrottle : public content::NavigationThrottle {
 public:
  static void MaybeAdd(content::NavigationThrottleRegistry& registry);

  explicit BayAppLinkThrottle(content::NavigationThrottleRegistry& registry);
  BayAppLinkThrottle(const BayAppLinkThrottle&) = delete;
  BayAppLinkThrottle& operator=(const BayAppLinkThrottle&) = delete;
  ~BayAppLinkThrottle() override;

  // content::NavigationThrottle:
  ThrottleCheckResult WillStartRequest() override;
  const char* GetNameForLogging() override;
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_APP_LINK_THROTTLE_H_
