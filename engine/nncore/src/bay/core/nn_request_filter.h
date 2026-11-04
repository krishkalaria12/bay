// The host's request filter (Bay's content blocker, packages/adblock): every web request a
// page makes is put to it before it starts, and the ones it blocks fail with
// net::ERR_BLOCKED_BY_CLIENT (counted by TabBridge as any blocked request).
//
// Subresources (a document's, a worker's, a service worker's) pass through a URLLoaderFactory
// interceptor the browser process puts in front of the network service for each factory
// (NNContentBrowserClient::WillCreateURLLoaderFactory, as Chrome's webRequest does), on a
// background sequence. Subframe navigations go through a NavigationThrottle on the UI thread,
// which blocks and collapses the frame. Main-frame navigations are never blocked, except a
// page opening one the host refuses ($popup), whose new tab closes. Navigations (main frames
// and subframes) pass through the same interceptor only so a filter's rewrite ($removeparam)
// can apply, as an internal redirect, and the host's Content-Security-Policy ($csp) can be
// added to their responses.
//
// The blocker's scriptlets reach a document synchronously as its main world starts
// (mojom::NNScriptlets, answered on a background sequence by the host's ScriptletSource).

#ifndef BAY_CORE_NN_REQUEST_FILTER_H_
#define BAY_CORE_NN_REQUEST_FILTER_H_

#include "content/public/browser/content_browser_client.h"
#include "services/service_manager/public/cpp/binder_registry.h"

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
// "other", "document" for a navigation, and "popup" for a page a page opens, whose source and
// top are the opener). Called on any thread, so it must be thread-safe and quick. true blocks.
// redirect is null for subframe throttling and WebSockets. Otherwise the host may set it to a
// malloc-allocated URL, which the engine frees: for a blocked request, a data URL answered in
// its place (a stand-in); for an allowed one, a URL of the same origin to load instead (the
// request with tracking parameters removed). Anything else is ignored.
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

// The Content-Security-Policy a document's response gets (type "document" or "subdocument"):
// malloc-allocated, freed by the engine; null for none. On a background sequence, while the
// navigation waits, so it must be thread-safe and quick.
using ContentSecurityPolicySource = char* (*)(const char* url,
                                              const char* source,
                                              const char* top,
                                              const char* type);
void SetContentSecurityPolicySource(ContentSecurityPolicySource source);

// The host's scriptlets for a document (frame_url) in a tab at top_origin: malloc-allocated
// JavaScript for its main world, freed by the engine; null or "" for none. Called on a
// background sequence while the document's renderer waits, so it must be thread-safe and quick.
using ScriptletSource = char* (*)(const char* frame_url, const char* top_origin);
void SetScriptletSource(ScriptletSource source);
// From NNContentBrowserClient::ExposeInterfacesToRenderer: mojom::NNScriptlets for a renderer.
void ExposeScriptlets(service_manager::BinderRegistry* registry);
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
