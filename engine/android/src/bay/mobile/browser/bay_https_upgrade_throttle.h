// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_HTTPS_UPGRADE_THROTTLE_H_
#define BAY_MOBILE_BROWSER_BAY_HTTPS_UPGRADE_THROTTLE_H_

#include "content/public/browser/navigation_throttle.h"

namespace bay {

// HTTPS first, for every page a tab opens, typed or followed: a main-frame `http:` GET loads its `https:` address
// instead. A host whose HTTPS can't connect, has a bad certificate or sends the tab straight back to HTTP loads over
// HTTP for the rest of the session. Local hosts (localhost, IP addresses, .local and the like) are never upgraded,
// and history navigations keep the address they had.
class BayHttpsUpgradeThrottle : public content::NavigationThrottle {
 public:
  static void MaybeAdd(content::NavigationThrottleRegistry& registry);

  explicit BayHttpsUpgradeThrottle(content::NavigationThrottleRegistry& registry);
  BayHttpsUpgradeThrottle(const BayHttpsUpgradeThrottle&) = delete;
  BayHttpsUpgradeThrottle& operator=(const BayHttpsUpgradeThrottle&) = delete;
  ~BayHttpsUpgradeThrottle() override;

  // content::NavigationThrottle:
  ThrottleCheckResult WillStartRequest() override;
  ThrottleCheckResult WillRedirectRequest() override;
  ThrottleCheckResult WillFailRequest() override;
  const char* GetNameForLogging() override;

 private:
  // Starts the same navigation at `url` in place of this one, which is cancelled.
  ThrottleCheckResult Restart(const GURL& url);
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_HTTPS_UPGRADE_THROTTLE_H_
