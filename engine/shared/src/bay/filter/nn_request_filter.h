// The host's request filter (Bay's content blocker, packages/adblock): every web request a
// page makes is put to it before it starts, and the ones it blocks fail with
// net::ERR_BLOCKED_BY_CLIENT (counted by TabBridge as any blocked request).
//
// Subresources (a document's, a worker's, a service worker's) pass through a URLLoaderFactory
// interceptor the browser process puts in front of the network service for each factory
// (NNContentBrowserClient::WillCreateURLLoaderFactory, as Chrome's webRequest does), on a
// background sequence. Subframe navigations go through a NavigationThrottle on the UI thread,
// which blocks and collapses the frame. A main frame's navigation goes through one too: one a
// page opened that the host refuses ($popup) stops and its new tab closes, and any other the
// host blocks ($doc, a hostname's rule) stops at an error page the host covers with its own.
// Navigations also pass through the same interceptor, but only so a filter's rewrite
// ($removeparam) can apply, as an internal redirect, and the host's Content-Security-Policy
// ($csp) can be added to their responses.
//
// A response goes through the same interceptor: the host's response rules see its headers, what its
// hostname is a CNAME of can still block it, and body rules ($replace, HTML ##^) rewrite its body.
//
// The blocker's scriptlets reach a document synchronously as its main world starts
// (mojom::NNScriptlets, answered on a background sequence by the host's ScriptletSource).

#ifndef BAY_FILTER_NN_REQUEST_FILTER_H_
#define BAY_FILTER_NN_REQUEST_FILTER_H_

#include <stddef.h>
#include <stdint.h>

#include "content/public/browser/content_browser_client.h"
#include "bay/filter/nn_cookie_filter.h"
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
// "other", "document" for a main frame's navigation, whose source and top are its URL, and
// "popup" for a page a page opens, whose source and top are the opener). Called on any thread,
// so it must be thread-safe and quick. true blocks.
// redirect is null for subframe throttling and WebSockets. Otherwise the host may set it to a
// malloc-allocated URL, which the engine frees: for a blocked request, a data URL answered in
// its place (a stand-in); for an allowed one, a URL to load instead (the request with tracking
// parameters removed, or a $urlskip target). Anything else is ignored. any_origin may be set
// to true when that replacement may cross origins (a $urlskip); it is null where there is no
// redirect.
using RequestFilter = bool (*)(const char* url,
                               const char* source,
                               const char* top,
                               const char* type,
                               const char* method,
                               char** redirect,
                               bool* any_origin);

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

// The response rules for a request ($header, $ipaddress, $permissions, ##^responseheader). `headers_json` is
// [["Name","value"], ...]; `ip` is the remote address or null. Returns malloc-allocated JSON
// {"blocked": bool, "redirect": data URL answered in a blocked response's place, "add": [[name, value]],
// "remove": [name]}, which the engine frees; null for no change. Called on a background sequence before the response
// reaches the renderer, so it must be thread-safe and quick.
using ResponseFilter = char* (*)(const char* url,
                                 const char* source,
                                 const char* top,
                                 const char* type,
                                 const char* method,
                                 const char* ip,
                                 const char* headers_json);
void SetResponseFilter(ResponseFilter filter);

// Whether the host's body rules ($replace, HTML ##^) want a response's body. status is its HTTP status;
// content_type and content_disposition its headers, or "". Called on a background sequence for every
// response while a filter is set, so it must be thread-safe and quick.
using BodyFilterGate = bool (*)(const char* url,
                                const char* source,
                                const char* top,
                                const char* type,
                                const char* method,
                                int status,
                                const char* content_type,
                                const char* content_disposition);
// A body the gate asked for, whole, with any Content-Encoding removed: a malloc-allocated replacement of
// *out_length bytes, which the engine frees, or null to leave it. Called on a thread pool, so it must be
// thread-safe, but it may take its time.
using BodyFilter = uint8_t* (*)(const char* url,
                                const char* source,
                                const char* top,
                                const char* type,
                                const char* method,
                                const char* content_type,
                                const uint8_t* body,
                                size_t length,
                                size_t* out_length);
void SetBodyFilter(BodyFilterGate gate, BodyFilter filter);

// $requestheader. names: a malloc-allocated JSON array of the lowercase headers the host's rules read for
// this request, which the engine frees, or null for none (most requests); on a background sequence for
// every request while set, so thread-safe and quick. filter: whether a request with these headers
// ([["Name","value"], ...]) is blocked. The engine adds the Cookie header the request would send.
using RequestHeaderNames = char* (*)(const char* url,
                                     const char* source,
                                     const char* top,
                                     const char* type,
                                     const char* method);
using RequestHeaderFilter = bool (*)(const char* url,
                                     const char* source,
                                     const char* top,
                                     const char* type,
                                     const char* method,
                                     const char* headers_json);
void SetRequestHeaderFilter(RequestHeaderNames names, RequestHeaderFilter filter);

// Whether a response is blocked by alias, a name the request's hostname is a CNAME of. Called on a
// background sequence for each alias of each response that has some, so thread-safe and quick.
using CnameFilter = bool (*)(const char* url,
                             const char* alias,
                             const char* source,
                             const char* top,
                             const char* type,
                             const char* method);
void SetCnameFilter(CnameFilter filter);

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
// The returned callback installs cookie interception after Chrome's header clients.
using ResponseCookieFilterInstaller = base::OnceCallback<void(
    mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>*)>;
ResponseCookieFilterInstaller MaybeFilterURLLoaderFactory(
    content::ContentBrowserClient::URLLoaderFactoryType type,
    const url::Origin& request_initiator,
    const net::IsolationInfo& isolation_info,
    network::URLLoaderFactoryBuilder& factory_builder,
    content::RenderFrameHost* frame);

// From NNContentBrowserClient::CreateThrottlesForNavigation.
void MaybeAddRequestFilterThrottle(content::NavigationThrottleRegistry& registry);

}  // namespace nncore

#endif  // BAY_FILTER_NN_REQUEST_FILTER_H_
