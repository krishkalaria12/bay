// The host's request filter (Bay's content blocker, packages/adblock): every web request a
// page makes is put to it before it starts, and the ones it blocks fail with
// net::ERR_BLOCKED_BY_CLIENT (counted by TabBridge as any blocked request).
//
// Subresources (a document's, a worker's, a service worker's) pass through a URLLoaderFactory
// interceptor the browser process puts in front of the network service for each factory
// (NNContentBrowserClient::WillCreateURLLoaderFactory, as Chrome's webRequest does), on a
// background sequence. Subframe navigations go through a NavigationThrottle on the UI thread,
// which blocks and collapses the frame. Main-frame navigations are never filtered.

#ifndef BAY_CORE_NN_REQUEST_FILTER_H_
#define BAY_CORE_NN_REQUEST_FILTER_H_

#include "content/public/browser/content_browser_client.h"

namespace content {
class NavigationThrottleRegistry;
struct GlobalRenderFrameHostId;
}
namespace net {
class IsolationInfo;
class SiteForCookies;
}
namespace network {
class URLLoaderFactoryBuilder;
}
namespace url {
class Origin;
}

namespace nncore {

// url: the request. source: the URL (or origin) of the document or worker asking. top: the
// tab's page (its origin for subresources). type: an adblock resource type ("script",
// "image", "stylesheet", "font", "media", "subdocument", "xmlhttprequest", "ping", "object",
// "other"). Called on any thread, so it must be thread-safe and quick. true blocks.
// redirect is null for frames/WebSockets; otherwise the host may set it to a malloc-allocated
// data URL for a blocked request. The engine owns and frees the returned string.
using RequestFilter = bool (*)(const char* url,
                               const char* source,
                               const char* top,
                               const char* type,
                               const char* method,
                               char** redirect);

// nullptr (the default) filters nothing; factories made before a filter was set pass their
// requests to the one current when each request starts.
void SetRequestFilter(RequestFilter filter);
bool HasRequestFilter();
bool ShouldBlockWebSocket(content::RenderFrameHost* frame,
                         const GURL& url,
                         const net::SiteForCookies& site_for_cookies);

// On the UI thread, count a successful local stand-in using the tab's canonical accounting.
void NoteContentBlockerRedirect(content::GlobalRenderFrameHostId frame,
                               const GURL& url);

// From NNContentBrowserClient::WillCreateURLLoaderFactory, before Chrome's own interceptors.
void MaybeFilterURLLoaderFactory(
    content::ContentBrowserClient::URLLoaderFactoryType type,
    const url::Origin& request_initiator,
    const net::IsolationInfo& isolation_info,
    network::URLLoaderFactoryBuilder& factory_builder,
    content::RenderFrameHost* frame);

// From NNContentBrowserClient::CreateThrottlesForNavigation.
void MaybeAddRequestFilterThrottle(content::NavigationThrottleRegistry& registry);

}  // namespace nncore

#endif  // BAY_CORE_NN_REQUEST_FILTER_H_
