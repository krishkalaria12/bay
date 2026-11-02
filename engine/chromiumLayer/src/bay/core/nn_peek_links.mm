#include "bay/core/nn_peek_links.h"

#import <Foundation/Foundation.h>

#include <memory>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "bay/core/nn_browser.h"
#import "bay/core/nncore_internal.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "net/base/registry_controlled_domains/registry_controlled_domain.h"
#include "ui/base/page_transition_types.h"
#include "url/gurl.h"

namespace nncore {

namespace {

bool PeeksLinks(content::WebContents* contents) {
  TabBridge* bridge = contents ? TabBridge::FromWebContents(contents) : nullptr;
  return bridge && bridge->peeks_links();
}

// Another site: not the same registrable domain (Chrome's "site", private registries included,
// so two github.io pages are two sites), or another host where there's none (an IP address).
bool OtherSite(const GURL& from, const GURL& to) {
  return !net::registry_controlled_domains::SameDomainOrHost(
      from, to, net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES);
}

void ReportPeek(base::WeakPtr<content::WebContents> contents, const GURL& url) {
  if (!contents || !PeeksLinks(contents.get())) {
    return;
  }
  NNCoreTab* tab = TabBridge::GetOrCreate(contents.get())->tab();
  id<NNCoreTabDelegate> delegate = tab.delegate;
  if ([delegate respondsToSelector:@selector(tab:wantsPeekOfURL:)]) {
    [delegate tab:tab wantsPeekOfURL:base::SysUTF8ToNSString(url.spec())];
  }
}

class PeekLinksThrottle : public content::NavigationThrottle {
 public:
  explicit PeekLinksThrottle(content::NavigationThrottleRegistry& registry)
      : content::NavigationThrottle(registry) {}

  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }
  const char* GetNameForLogging() override { return "NNPeekLinksThrottle"; }

 private:
  ThrottleCheckResult Check() {
    content::WebContents* contents = navigation_handle()->GetWebContents();
    const GURL& to = navigation_handle()->GetURL();
    const GURL& from = contents->GetPrimaryMainFrame()->GetLastCommittedURL();
    if (!to.SchemeIsHTTPOrHTTPS() || !from.SchemeIsHTTPOrHTTPS() || !OtherSite(from, to) ||
        !PeeksLinks(contents)) {
      return PROCEED;
    }
    // After this navigation is gone: the host may load the peek, or close this tab, at once.
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&ReportPeek, contents->GetWeakPtr(), to));
    return CANCEL_AND_IGNORE;
  }
};

}  // namespace

void MaybeAddPeekLinksThrottle(content::NavigationThrottleRegistry& registry) {
  content::NavigationHandle& handle = registry.GetNavigationHandle();
  // A link the user clicked in the tab's own page: not an address typed or a bookmark (the host's,
  // browser-initiated), back or forward, a reload, a form, a script with no click, nor a frame.
  if (!handle.IsInPrimaryMainFrame() || !handle.IsRendererInitiated() || !handle.HasUserGesture() ||
      !ui::PageTransitionCoreTypeIs(handle.GetPageTransition(), ui::PAGE_TRANSITION_LINK) ||
      !PeeksLinks(handle.GetWebContents())) {
    return;
  }
  registry.AddThrottle(std::make_unique<PeekLinksThrottle>(registry));
}

}  // namespace nncore
