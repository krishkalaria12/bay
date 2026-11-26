// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_app_link_throttle.h"

#include "bay/mobile/browser/bay_tab.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "net/base/registry_controlled_domains/registry_controlled_domain.h"
#include "ui/base/page_transition_types.h"

namespace bay {

namespace {

// Another site than the page's: a different registrable domain, as "maps.google.com" is the same site as
// "www.google.com". A tab with no page yet has no site, so every link from it counts as another.
bool IsAnotherSite(const GURL& url, const GURL& page) {
  return !page.SchemeIsHTTPOrHTTPS() ||
         !net::registry_controlled_domains::SameDomainOrHost(
             url, page, net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES);
}

}  // namespace

// static
void BayAppLinkThrottle::MaybeAdd(content::NavigationThrottleRegistry& registry) {
  if (registry.GetNavigationHandle().IsInPrimaryMainFrame()) {
    registry.AddThrottle(std::make_unique<BayAppLinkThrottle>(registry));
  }
}

BayAppLinkThrottle::BayAppLinkThrottle(content::NavigationThrottleRegistry& registry)
    : content::NavigationThrottle(registry) {}

BayAppLinkThrottle::~BayAppLinkThrottle() = default;

content::NavigationThrottle::ThrottleCheckResult BayAppLinkThrottle::WillStartRequest() {
  content::NavigationHandle* navigation = navigation_handle();
  const GURL& url = navigation->GetURL();
  const ui::PageTransition transition = navigation->GetPageTransition();
  // Only a link the person tapped: a page's own redirects and scripted navigations, typed addresses and history stay.
  if (!url.SchemeIsHTTPOrHTTPS() || navigation->IsPost() || !navigation->IsRendererInitiated() ||
      !navigation->HasUserGesture() || !ui::PageTransitionCoreTypeIs(transition, ui::PAGE_TRANSITION_LINK) ||
      (transition & ui::PAGE_TRANSITION_FORWARD_BACK) ||
      !IsAnotherSite(url, navigation->GetWebContents()->GetLastCommittedURL())) {
    return PROCEED;
  }
  BayTab* tab = BayTab::FromWebContents(navigation->GetWebContents());
  return tab && tab->OpenAppLink(url) ? CANCEL_AND_IGNORE : PROCEED;
}

const char* BayAppLinkThrottle::GetNameForLogging() {
  return "BayAppLinkThrottle";
}

}  // namespace bay
