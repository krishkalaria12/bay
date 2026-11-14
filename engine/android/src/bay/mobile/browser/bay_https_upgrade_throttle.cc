// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_https_upgrade_throttle.h"

#include <map>
#include <set>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "bay/mobile/browser/bay_tab.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/referrer.h"
#include "net/base/net_errors.h"
#include "net/base/url_util.h"
#include "ui/base/page_transition_types.h"
#include "url/url_constants.h"

namespace bay {

namespace {

// How long after an upgrade a redirect back to HTTP counts as the site refusing HTTPS.
constexpr base::TimeDelta kRedirectBackWindow = base::Seconds(5);

// Hosts that failed over HTTPS this session; they load over HTTP from then on.
std::set<std::string>& HttpOnlyHosts() {
  static base::NoDestructor<std::set<std::string>> hosts;
  return *hosts;
}

// Hosts this session moved from HTTP to HTTPS, with when.
std::map<std::string, base::TimeTicks>& UpgradedHosts() {
  static base::NoDestructor<std::map<std::string, base::TimeTicks>> hosts;
  return *hosts;
}

bool IsLocal(const GURL& url) {
  if (net::IsLocalhost(url) || url.HostIsIPAddress()) {
    return true;
  }
  const std::string_view host = url.host();
  for (std::string_view suffix : {".local", ".localhost", ".test", ".internal", ".lan", ".home.arpa"}) {
    if (base::EndsWith(host, suffix)) {
      return true;
    }
  }
  return false;
}

bool UpgradedRecently(const GURL& url) {
  auto it = UpgradedHosts().find(url.host());
  return it != UpgradedHosts().end() && base::TimeTicks::Now() - it->second < kRedirectBackWindow;
}

// The errors after which an upgraded address falls back to HTTP: the site doesn't serve HTTPS, or not properly.
bool IsHttpsFailure(int error) {
  switch (error) {
    case net::ERR_CONNECTION_REFUSED:
    case net::ERR_CONNECTION_RESET:
    case net::ERR_CONNECTION_CLOSED:
    case net::ERR_CONNECTION_TIMED_OUT:
    case net::ERR_TIMED_OUT:
    case net::ERR_ADDRESS_UNREACHABLE:
    case net::ERR_EMPTY_RESPONSE:
    case net::ERR_SSL_PROTOCOL_ERROR:
    case net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH:
      return true;
    default:
      return net::IsCertificateError(error);
  }
}

GURL WithScheme(const GURL& url, std::string_view scheme) {
  GURL::Replacements replacements;
  replacements.SetSchemeStr(scheme);
  // The default port of one scheme isn't the other's.
  if (url.IntPort() == (scheme == url::kHttpsScheme ? 80 : 443)) {
    replacements.ClearPort();
  }
  return url.ReplaceComponents(replacements);
}

}  // namespace

// static
void BayHttpsUpgradeThrottle::MaybeAdd(content::NavigationThrottleRegistry& registry) {
  if (registry.GetNavigationHandle().IsInPrimaryMainFrame()) {
    registry.AddThrottle(std::make_unique<BayHttpsUpgradeThrottle>(registry));
  }
}

BayHttpsUpgradeThrottle::BayHttpsUpgradeThrottle(content::NavigationThrottleRegistry& registry)
    : content::NavigationThrottle(registry) {}

BayHttpsUpgradeThrottle::~BayHttpsUpgradeThrottle() = default;

content::NavigationThrottle::ThrottleCheckResult BayHttpsUpgradeThrottle::WillStartRequest() {
  content::NavigationHandle* navigation = navigation_handle();
  const GURL& url = navigation->GetURL();
  const bool history = navigation->GetPageTransition() & ui::PAGE_TRANSITION_FORWARD_BACK;
  if (!url.SchemeIs(url::kHttpScheme) || navigation->IsPost() || history || IsLocal(url) ||
      HttpOnlyHosts().contains(url.host())) {
    return PROCEED;
  }
  if (UpgradedRecently(url)) {
    // The HTTPS page sent the tab straight back to HTTP: the site doesn't serve HTTPS properly, so keep HTTP.
    HttpOnlyHosts().insert(url.host());
    return PROCEED;
  }
  UpgradedHosts()[url.host()] = base::TimeTicks::Now();
  return Restart(WithScheme(url, url::kHttpsScheme));
}

content::NavigationThrottle::ThrottleCheckResult BayHttpsUpgradeThrottle::WillRedirectRequest() {
  const GURL& url = navigation_handle()->GetURL();
  // An upgraded page redirecting to its own HTTP address would loop; it keeps HTTP instead.
  if (url.SchemeIs(url::kHttpScheme) && UpgradedRecently(url)) {
    HttpOnlyHosts().insert(url.host());
  }
  return PROCEED;
}

content::NavigationThrottle::ThrottleCheckResult BayHttpsUpgradeThrottle::WillFailRequest() {
  const GURL& url = navigation_handle()->GetURL();
  if (!url.SchemeIs(url::kHttpsScheme) || !UpgradedHosts().contains(url.host()) ||
      HttpOnlyHosts().contains(url.host()) || !IsHttpsFailure(navigation_handle()->GetNetErrorCode())) {
    return PROCEED;
  }
  HttpOnlyHosts().insert(url.host());
  return Restart(WithScheme(url, url::kHttpScheme));
}

const char* BayHttpsUpgradeThrottle::GetNameForLogging() {
  return "BayHttpsUpgradeThrottle";
}

content::NavigationThrottle::ThrottleCheckResult BayHttpsUpgradeThrottle::Restart(const GURL& url) {
  content::NavigationHandle* navigation = navigation_handle();
  content::NavigationController::LoadURLParams params(url);
  params.transition_type = navigation->GetPageTransition();
  params.referrer = content::Referrer(navigation->GetReferrer());
  params.initiator_origin = navigation->GetInitiatorOrigin();
  params.is_renderer_initiated = navigation->IsRendererInitiated() && params.initiator_origin.has_value();
  params.has_user_gesture = navigation->HasUserGesture();
  // The tab's desktop site setting carries over (BayTab.setDesktopMode).
  BayTab* tab = BayTab::FromWebContents(navigation->GetWebContents());
  params.override_user_agent = tab && tab->desktop_mode() ? content::NavigationController::UA_OVERRIDE_TRUE
                                                          : content::NavigationController::UA_OVERRIDE_FALSE;
  // A navigation can't start another from inside its own throttle; it does once this one is cancelled.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<content::WebContents> web_contents,
                        content::NavigationController::LoadURLParams params) {
                       if (web_contents) {
                         web_contents->GetController().LoadURLWithParams(params);
                       }
                     },
                     navigation->GetWebContents()->GetWeakPtr(), std::move(params)));
  return CANCEL_AND_IGNORE;
}

}  // namespace bay
