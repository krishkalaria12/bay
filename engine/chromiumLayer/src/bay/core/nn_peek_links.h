#ifndef BAY_CORE_NN_PEEK_LINKS_H_
#define BAY_CORE_NN_PEEK_LINKS_H_

namespace content {
class NavigationThrottleRegistry;
}

namespace nncore {

// Arc's Peek for a link click. In a tab the host marked (-[NNCoreTab setPeeksLinks:]: a pinned
// tab or a favourite), a link the user clicks in the main frame that takes the tab to another
// site doesn't navigate it: the throttle cancels the navigation, the page stays, and the host
// hears tab:wantsPeekOfURL: to show that page over the tab. A redirect that leaves the site counts
// the same (a search result's or a link shortener's hop). Links that open a tab (target=_blank,
// ⌘-click) aren't navigations of this tab: they reach the host as openWindow, as always.

// For CreateThrottlesForNavigation: adds the throttle to a marked tab's clicked link only.
void MaybeAddPeekLinksThrottle(content::NavigationThrottleRegistry& registry);

}  // namespace nncore

#endif  // BAY_CORE_NN_PEEK_LINKS_H_
