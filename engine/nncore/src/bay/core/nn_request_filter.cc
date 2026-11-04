#include "bay/core/nn_request_filter.h"

#include <atomic>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>

#include "base/byte_size.h"
#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/stringprintf.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "bay/core/mojom/nncore.mojom.h"
#include "net/base/data_url.h"
#include "net/base/isolation_info.h"
#include "net/base/net_errors.h"
#include "net/cookies/site_for_cookies.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_status_code.h"
#include "net/http/http_util.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/cpp/url_loader_factory_builder.h"
#include "services/network/public/mojom/early_hints.mojom.h"
#include "services/network/public/mojom/fetch_api.mojom-shared.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace nncore {

namespace {

std::atomic<RequestFilter> g_filter{nullptr};
std::atomic<ContentSecurityPolicySource> g_csp_source{nullptr};

bool IsWeb(const GURL& url) {
  return url.SchemeIsHTTPOrHTTPS() || url.SchemeIsWSOrWSS();
}

// The URL of an origin, "" for an opaque one (a sandboxed frame's).
std::string OriginURL(const url::Origin& origin) {
  return origin.opaque() ? std::string() : origin.GetURL().spec();
}

// adblock-rust's request types (packages/adblock), by what the request is for.
const char* TypeOf(const network::ResourceRequest& request) {
  // Fetch remains XHR even with keepalive set; only non-fetch keepalive traffic
  // such as sendBeacon is a ping (as in Chrome's webRequest classification).
  if (request.is_fetch_like_api) {
    return "xmlhttprequest";
  }
  using Destination = network::mojom::RequestDestination;
  switch (request.destination) {
    case Destination::kScript:
    case Destination::kWorker:
    case Destination::kSharedWorker:
    case Destination::kServiceWorker:
    case Destination::kAudioWorklet:
    case Destination::kPaintWorklet:
    case Destination::kSpeculationRules:
      return "script";
    case Destination::kImage:
      return "image";
    case Destination::kStyle:
    case Destination::kXslt:
      return "stylesheet";
    case Destination::kFont:
      return "font";
    case Destination::kAudio:
    case Destination::kVideo:
    case Destination::kTrack:
      return "media";
    case Destination::kDocument:
      return "document";
    case Destination::kFrame:
    case Destination::kIframe:
    case Destination::kFencedframe:
      return "subdocument";
    case Destination::kObject:
    case Destination::kEmbed:
      return "object";
    case Destination::kReport:
      return "ping";
    case Destination::kEmpty:
      // fetch(), XMLHttpRequest, and sendBeacon / keepalive pings.
      return request.keepalive ? "ping" : "xmlhttprequest";
    default:
      return "other";
  }
}

struct Decision {
  bool blocked = false;
  // For a blocked request, a data URL answered in its place (a stand-in); for an allowed
  // one, a URL of its origin to load instead (its tracking parameters removed).
  std::string redirect;
};

// Who is asking for a request, and the page it's for.
struct RequestContext {
  std::string source;
  std::string top;
};

RequestContext ContextOf(const network::ResourceRequest& request,
                         const std::string& factory_source,
                         const std::string& factory_top) {
  // A top-level document is its own context, as uBO judges a main_frame request.
  if (request.destination == network::mojom::RequestDestination::kDocument) {
    return {request.url.spec(), request.url.spec()};
  }
  std::string source = request.request_initiator
                           ? OriginURL(*request.request_initiator)
                           : std::string();
  if (source.empty()) {
    source = factory_source;
  }
  std::string top = factory_top.empty() ? source : factory_top;
  return {std::move(source), std::move(top)};
}

Decision Match(const network::ResourceRequest& request,
               const std::string& factory_source,
               const std::string& factory_top) {
  RequestFilter filter = g_filter.load(std::memory_order_acquire);
  if (!filter || !IsWeb(request.url)) {
    return {};
  }
  const RequestContext context = ContextOf(request, factory_source, factory_top);
  char* redirect = nullptr;
  Decision result;
  result.blocked =
      filter(request.url.spec().c_str(), context.source.c_str(), context.top.c_str(),
             TypeOf(request), request.method.c_str(), &redirect);
  if (redirect) {
    result.redirect = redirect;
    free(redirect);
  }
  return result;
}

// The URL an allowed request loads instead (a $removeparam rewrite): a web URL of the same
// origin that differs from `url`; empty for none.
GURL RewriteOf(const Decision& decision, const GURL& url) {
  if (decision.blocked || decision.redirect.empty()) {
    return GURL();
  }
  GURL rewritten(decision.redirect);
  if (!rewritten.is_valid() || !rewritten.SchemeIsHTTPOrHTTPS() || rewritten == url ||
      !url::IsSameOriginWith(rewritten, url)) {
    return GURL();
  }
  return rewritten;
}

// An in-browser stand-in, as an extension's redirect resource would answer the
// original URL. Only data URLs are accepted, so this never issues another request.
struct ResourceResponse {
  mojo::Remote<network::mojom::URLLoaderClient> client;
  std::string body;
  std::unique_ptr<mojo::DataPipeProducer> producer;
};

void ResourceWritten(std::unique_ptr<ResourceResponse> response,
                     MojoResult result) {
  network::URLLoaderCompletionStatus status(
      result == MOJO_RESULT_OK ? net::OK : net::ERR_FAILED);
  status.encoded_data_length = base::ByteSize(response->body.size());
  status.encoded_body_length = base::ByteSize(response->body.size());
  status.decoded_body_length = base::ByteSize(response->body.size());
  response->client->OnComplete(status);
}

void CompleteBlocked(
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    const Decision& decision,
    const std::optional<content::GlobalRenderFrameHostId>& frame,
    const GURL& original_url) {
  mojo::Remote<network::mojom::URLLoaderClient> remote(std::move(client));
  const GURL url(decision.redirect);
  if (decision.redirect.empty() || !url.SchemeIs("data")) {
    remote->OnComplete(
        network::URLLoaderCompletionStatus(net::ERR_BLOCKED_BY_CLIENT));
    return;
  }
  auto response = std::make_unique<ResourceResponse>();
  response->client = std::move(remote);
  auto head = network::mojom::URLResponseHead::New();
  const net::Error error = net::DataURL::BuildResponse(
      url, "GET", &head->mime_type, &head->charset, &response->body,
      &head->headers);
  if (error != net::OK) {
    response->client->OnComplete(
        network::URLLoaderCompletionStatus(net::ERR_BLOCKED_BY_CLIENT));
    return;
  }
  head->headers->SetHeader("Access-Control-Allow-Origin", "*");
  head->content_length = response->body.size();
  mojo::ScopedDataPipeProducerHandle producer;
  mojo::ScopedDataPipeConsumerHandle consumer;
  if (mojo::CreateDataPipe(nullptr, producer, consumer) != MOJO_RESULT_OK) {
    response->client->OnComplete(
        network::URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
    return;
  }
  if (frame) {
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE, base::BindOnce(&NoteContentBlockerRedirect, *frame, original_url));
  }
  response->client->OnReceiveResponse(std::move(head), std::move(consumer),
                                     std::nullopt);
  response->producer =
      std::make_unique<mojo::DataPipeProducer>(std::move(producer));
  mojo::DataPipeProducer* writer = response->producer.get();
  auto source = std::make_unique<mojo::StringDataSource>(
      response->body, mojo::StringDataSource::AsyncWritingMode::
                          STRING_STAYS_VALID_UNTIL_COMPLETION);
  writer->Write(std::move(source),
               base::BindOnce(&ResourceWritten, std::move(response)));
}

// The host's Content-Security-Policy for a navigation's response ($csp), as one more header.
// Chrome enforces the parsed headers, so those are parsed again (NavigationURLLoaderImpl
// does it when they're missing, as for a webRequest extension's changes).
void AddContentSecurityPolicy(const network::ResourceRequest& request,
                              const std::string& factory_source,
                              const std::string& factory_top,
                              network::mojom::URLResponseHead& head) {
  ContentSecurityPolicySource policy_source =
      g_csp_source.load(std::memory_order_acquire);
  if (!policy_source || !head.headers || !request.url.SchemeIsHTTPOrHTTPS()) {
    return;
  }
  const RequestContext context = ContextOf(request, factory_source, factory_top);
  char* policy = policy_source(request.url.spec().c_str(), context.source.c_str(),
                                  context.top.c_str(), TypeOf(request));
  if (!policy) {
    return;
  }
  auto headers = base::MakeRefCounted<net::HttpResponseHeaders>(head.headers->raw_headers());
  headers->AddHeader("Content-Security-Policy", policy);
  free(policy);
  head.headers = std::move(headers);
  head.parsed_headers.reset();
}

class FilteringFactory;

// Keeps the browser between the network service and the renderer until completion.
// A redirect is checked before the renderer can follow it, including an override
// passed through FollowRedirect. Closing either endpoint cancels the request.
//
// A rewrite ($removeparam) is answered as Chrome's webRequest answers an extension's
// redirect: the client gets a redirect to the new URL (an internal 307, or the server's
// redirect pointed there), the network request is dropped, and a new one starts when the
// client follows. A navigation's loader only rewrites: subframes are blocked by
// RequestFilterThrottle, main frames never.
class FilteringLoader : public network::mojom::URLLoader,
                        public network::mojom::URLLoaderClient {
 public:
  FilteringLoader(base::WeakPtr<FilteringFactory> factory,
                  mojo::PendingReceiver<network::mojom::URLLoader> loader,
                  mojo::PendingRemote<network::mojom::URLLoaderClient> client,
                  const network::ResourceRequest& request,
                  int32_t request_id,
                  uint32_t options,
                  const net::MutableNetworkTrafficAnnotationTag& annotation,
                  std::string source,
                  std::string top,
                  std::optional<content::GlobalRenderFrameHostId> frame,
                  bool navigation)
      : factory_(std::move(factory)),
        receiver_(this, std::move(loader)),
        client_(std::move(client)),
        request_(request),
        request_id_(request_id),
        options_(options),
        annotation_(annotation),
        source_(std::move(source)),
        top_(std::move(top)),
        frame_(frame),
        navigation_(navigation) {
    receiver_.set_disconnect_handler(
        base::BindOnce(&FilteringLoader::Destroy, base::Unretained(this)));
    client_.set_disconnect_handler(
        base::BindOnce(&FilteringLoader::Destroy, base::Unretained(this)));
  }

  // Starts the request, or first redirects its client to `rewrite` when that is valid.
  void Start(const GURL& rewrite) {
    if (rewrite.is_valid()) {
      return InternalRedirect(rewrite);
    }
    StartNetwork();
  }

  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers,
      const std::optional<GURL>& new_url) override {
    if (new_url) {
      request_.url = *new_url;
    }
    if (restart_pending_) {
      // The client followed a redirect this loader made: the request starts again there.
      restart_pending_ = false;
      for (const std::string& header : headers.removed_headers) {
        request_.headers.RemoveHeader(header);
      }
      request_.headers.MergeFrom(headers.modified_headers);
      request_.cors_exempt_headers.MergeFrom(headers.modified_cors_exempt_headers);
      if (!navigation_) {
        const Decision decision = Match(request_, source_, top_);
        if (decision.blocked) {
          return Block(decision);
        }
      }
      return StartNetwork();
    }
    if (new_url && !navigation_) {
      const Decision decision = Match(request_, source_, top_);
      if (decision.blocked) {
        return Block(decision);
      }
    }
    target_->FollowRedirect(std::move(headers), new_url);
  }

  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {
    if (target_) {
      target_->SetPriority(priority, intra_priority_value);
    }
  }

  void OnReceiveEarlyHints(network::mojom::EarlyHintsPtr hints) override {
    client_->OnReceiveEarlyHints(std::move(hints));
  }

  void OnReceiveResponse(network::mojom::URLResponseHeadPtr head,
                         mojo::ScopedDataPipeConsumerHandle body,
                         std::optional<mojo_base::BigBuffer> metadata) override {
    if (navigation_) {
      AddContentSecurityPolicy(request_, source_, top_, *head);
    }
    client_->OnReceiveResponse(std::move(head), std::move(body),
                               std::move(metadata));
  }

  void OnReceiveRedirect(const net::RedirectInfo& redirect,
                         network::mojom::URLResponseHeadPtr head) override {
    network::ResourceRequest next = request_;
    next.url = redirect.new_url;
    next.method = redirect.new_method;
    const Decision decision = Match(next, source_, top_);
    if (decision.blocked && !navigation_) {
      request_.url = redirect.new_url;
      return Block(decision);
    }
    const GURL rewrite =
        rewrites_ < kMaxRewrites ? RewriteOf(decision, redirect.new_url) : GURL();
    if (rewrite.is_valid()) {
      net::RedirectInfo rewritten = redirect;
      rewritten.new_url = rewrite;
      return RedirectClient(rewritten, std::move(head));
    }
    request_.url = redirect.new_url;
    request_.method = redirect.new_method;
    client_->OnReceiveRedirect(redirect, std::move(head));
  }

  void OnUploadProgress(int64_t current,
                        int64_t total,
                        OnUploadProgressCallback callback) override {
    client_->OnUploadProgress(current, total, std::move(callback));
  }

  void OnTransferSizeUpdated(int32_t delta) override {
    client_->OnTransferSizeUpdated(delta);
  }

  void OnComplete(const network::URLLoaderCompletionStatus& status) override {
    client_->OnComplete(status);
    Destroy();
  }

 private:
  // Each rewrite removes parameters, so a chain ends; this bounds one a server keeps redirecting.
  static constexpr int kMaxRewrites = 3;

  ~FilteringLoader() override = default;

  void StartNetwork();

  // An internal redirect to `url`, as Chrome's webRequest makes one for an extension.
  void InternalRedirect(const GURL& url) {
    constexpr int kStatus = net::HTTP_TEMPORARY_REDIRECT;
    const net::RedirectInfo info = net::RedirectInfo::ComputeRedirectInfo(
        request_.method, request_.url, request_.site_for_cookies,
        request_.update_first_party_url_on_redirect
            ? net::RedirectInfo::FirstPartyURLPolicy::UPDATE_URL_ON_REDIRECT
            : net::RedirectInfo::FirstPartyURLPolicy::NEVER_CHANGE_URL,
        request_.referrer_policy, request_.referrer.spec(), request_.request_initiator,
        kStatus, url, /*referrer_policy_header=*/std::nullopt,
        /*insecure_scheme_was_upgraded=*/false, /*copy_fragment=*/false,
        /*is_signed_exchange_fallback_redirect=*/false);
    auto head = network::mojom::URLResponseHead::New();
    head->headers = base::MakeRefCounted<net::HttpResponseHeaders>(
        net::HttpUtil::AssembleRawHeaders(base::StringPrintf(
            "HTTP/1.1 %i Internal Redirect\n"
            "Location: %s\n"
            "Non-Authoritative-Reason: Bay content blocker\n\n",
            kStatus, url.spec().c_str())));
    head->encoded_data_length = 0;
    RedirectClient(info, std::move(head));
  }

  // Sends the client a redirect this loader answers itself: the network request goes, and
  // FollowRedirect starts a new one at the redirect's URL.
  void RedirectClient(const net::RedirectInfo& info,
                      network::mojom::URLResponseHeadPtr head) {
    ++rewrites_;
    network_client_.reset();
    target_.reset();
    request_.url = info.new_url;
    request_.method = info.new_method;
    request_.site_for_cookies = info.new_site_for_cookies;
    request_.referrer = GURL(info.new_referrer);
    request_.referrer_policy = info.new_referrer_policy;
    restart_pending_ = true;
    client_->OnReceiveRedirect(info, std::move(head));
  }

  void Block(const Decision& decision) {
    CompleteBlocked(client_.Unbind(), decision, frame_, request_.url);
    Destroy();
  }

  void NetworkGone() {
    client_->OnComplete(network::URLLoaderCompletionStatus(net::ERR_FAILED));
    Destroy();
  }

  void Destroy() { delete this; }

  const base::WeakPtr<FilteringFactory> factory_;
  mojo::Receiver<network::mojom::URLLoader> receiver_;
  mojo::Remote<network::mojom::URLLoaderClient> client_;
  mojo::Remote<network::mojom::URLLoader> target_;
  mojo::Receiver<network::mojom::URLLoaderClient> network_client_{this};
  network::ResourceRequest request_;
  const int32_t request_id_;
  const uint32_t options_;
  const net::MutableNetworkTrafficAnnotationTag annotation_;
  const std::string source_;
  const std::string top_;
  const std::optional<content::GlobalRenderFrameHostId> frame_;
  const bool navigation_;
  bool restart_pending_ = false;
  int rewrites_ = 0;
};

// One URLLoaderFactory's interceptor: a blocked request is answered at once (an error or a
// stand-in); any other goes to the next factory through a FilteringLoader. A navigation's
// factory never blocks, only rewrites. Owns itself: it goes when its last receiver or its
// target does.
class FilteringFactory : public network::mojom::URLLoaderFactory {
 public:
  static void Create(
      mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
      mojo::PendingRemote<network::mojom::URLLoaderFactory> target,
      std::string source,
      std::string top,
      std::optional<content::GlobalRenderFrameHostId> frame,
      bool navigation) {
    new FilteringFactory(std::move(receiver), std::move(target), std::move(source),
                         std::move(top), frame, navigation);
  }

  FilteringFactory(const FilteringFactory&) = delete;
  FilteringFactory& operator=(const FilteringFactory&) = delete;

  network::mojom::URLLoaderFactory* target() { return target_.get(); }

  void CreateLoaderAndStart(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& annotation) override {
    const Decision decision = Match(request, source_, top_);
    if (decision.blocked && !navigation_) {
      return CompleteBlocked(std::move(client), decision, frame_, request.url);
    }
    auto* proxy = new FilteringLoader(weak_factory_.GetWeakPtr(), std::move(loader),
                                      std::move(client), request, request_id, options,
                                      annotation, source_, top_, frame_, navigation_);
    proxy->Start(RewriteOf(decision, request.url));
  }

  void Clone(mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver)
      override {
    receivers_.Add(this, std::move(receiver));
  }

 private:
  FilteringFactory(
      mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
      mojo::PendingRemote<network::mojom::URLLoaderFactory> target,
      std::string source,
      std::string top,
      std::optional<content::GlobalRenderFrameHostId> frame,
      bool navigation)
      : target_(std::move(target)),
        source_(std::move(source)),
        top_(std::move(top)),
        frame_(frame),
        navigation_(navigation) {
    receivers_.Add(this, std::move(receiver));
    receivers_.set_disconnect_handler(base::BindRepeating(
        &FilteringFactory::OnReceiverGone, base::Unretained(this)));
    target_.set_disconnect_handler(
        base::BindOnce(&FilteringFactory::Destroy, base::Unretained(this)));
  }

  ~FilteringFactory() override = default;

  void OnReceiverGone() {
    if (receivers_.empty()) {
      Destroy();
    }
  }

  void Destroy() { delete this; }

  mojo::ReceiverSet<network::mojom::URLLoaderFactory> receivers_;
  mojo::Remote<network::mojom::URLLoaderFactory> target_;
  // The factory's document or worker (its origin), the page it's in, and its frame if any.
  const std::string source_;
  const std::string top_;
  const std::optional<content::GlobalRenderFrameHostId> frame_;
  const bool navigation_;
  base::WeakPtrFactory<FilteringFactory> weak_factory_{this};
};

void FilteringLoader::StartNetwork() {
  if (!factory_) {
    // The factory's document went while a rewrite waited for its client.
    return NetworkGone();
  }
  factory_->target()->CreateLoaderAndStart(
      target_.BindNewPipeAndPassReceiver(), request_id_, options_, request_,
      network_client_.BindNewPipeAndPassRemote(), annotation_);
  network_client_.set_disconnect_handler(
      base::BindOnce(&FilteringLoader::NetworkGone, base::Unretained(this)));
}

// Every interceptor runs here: off the UI thread, one sequence for all (a check takes
// microseconds).
scoped_refptr<base::SequencedTaskRunner> FilterTaskRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::TaskPriority::USER_BLOCKING,
           base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN}));
  return *runner;
}

// Subframe navigations (iframes, frames, fenced frames), and each of their redirects.
class RequestFilterThrottle : public content::NavigationThrottle {
 public:
  explicit RequestFilterThrottle(content::NavigationThrottleRegistry& registry)
      : content::NavigationThrottle(registry) {}

  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }
  const char* GetNameForLogging() override { return "NNRequestFilterThrottle"; }

 private:
  ThrottleCheckResult Check() {
    RequestFilter filter = g_filter.load(std::memory_order_acquire);
    content::NavigationHandle* navigation = navigation_handle();
    const GURL& url = navigation->GetURL();
    content::RenderFrameHost* parent = navigation->GetParentFrameOrOuterDocument();
    if (!filter || !parent || !IsWeb(url)) {
      return PROCEED;
    }
    const std::string source = parent->GetLastCommittedURL().spec();
    const std::string top =
        parent->GetOutermostMainFrame()->GetLastCommittedURL().spec();
    return filter(url.spec().c_str(), source.c_str(), top.c_str(), "subdocument",
                  navigation->IsPost() ? "POST" : "GET", nullptr)
               ? BLOCK_REQUEST_AND_COLLAPSE
               : PROCEED;
  }
};

// A main frame's navigation, and each of its redirects. A page a page opens (a new tab or
// window's first navigation) that the host refuses ($popup) stops, and its new tab closes. Any
// other that the host blocks as a document ($doc, a hostname's rule) stops at an error page,
// which the host covers with its own: the entry stays, so Back and Reload work.
class MainFrameThrottle : public content::NavigationThrottle {
 public:
  explicit MainFrameThrottle(content::NavigationThrottleRegistry& registry)
      : content::NavigationThrottle(registry) {}

  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }
  const char* GetNameForLogging() override { return "NNMainFrameThrottle"; }

 private:
  ThrottleCheckResult Check() {
    RequestFilter filter = g_filter.load(std::memory_order_acquire);
    content::NavigationHandle* navigation = navigation_handle();
    if (!filter || !navigation->GetURL().SchemeIsHTTPOrHTTPS()) {
      return PROCEED;
    }
    const std::string url = navigation->GetURL().spec();
    const char* method = navigation->IsPost() ? "POST" : "GET";
    if (OpenedByAPage() && filter(url.c_str(), Opener().c_str(), Opener().c_str(), "popup",
                                  method, nullptr)) {
      // Not from inside the navigation's own start: closing destroys it.
      content::GetUIThreadTaskRunner({})->PostTask(
          FROM_HERE, base::BindOnce(
                         [](base::WeakPtr<content::WebContents> page) {
                           if (page) {
                             page->ClosePage();
                           }
                         },
                         navigation->GetWebContents()->GetWeakPtr()));
      return CANCEL;
    }
    if (!filter(url.c_str(), url.c_str(), url.c_str(), "document", method, nullptr)) {
      return PROCEED;
    }
    // A prerender just stops: nothing is shown, and a real visit is asked again.
    if (!navigation->IsInPrimaryMainFrame()) {
      return CANCEL;
    }
    return ThrottleCheckResult(BLOCK_REQUEST, net::ERR_BLOCKED_BY_CLIENT);
  }

  // The app's own navigations aren't renderer-initiated, and only a page opening one counts:
  // not one of Chrome's pages or an extension's.
  bool OpenedByAPage() {
    content::NavigationHandle* navigation = navigation_handle();
    const std::optional<url::Origin>& initiator = navigation->GetInitiatorOrigin();
    return navigation->IsInPrimaryMainFrame() && navigation->IsRendererInitiated() &&
           navigation->GetWebContents()->GetController().IsInitialNavigation() && initiator &&
           (initiator->opaque() || initiator->GetURL().SchemeIsHTTPOrHTTPS());
  }

  std::string Opener() {
    return OriginURL(*navigation_handle()->GetInitiatorOrigin());
  }
};

std::atomic<ScriptletSource> g_scriptlet_source{nullptr};

// The scriptlet lookups' own sequence: a renderer waits on each, so they don't queue behind
// the request filter's checks.
scoped_refptr<base::SequencedTaskRunner> ScriptletTaskRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::TaskPriority::USER_BLOCKING,
           base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN}));
  return *runner;
}

// mojom::NNScriptlets for every renderer, on ScriptletTaskRunner().
class ScriptletsHost : public mojom::NNScriptlets {
 public:
  static void Bind(mojo::PendingReceiver<mojom::NNScriptlets> receiver) {
    static base::NoDestructor<ScriptletsHost> host;
    host->receivers_.Add(host.get(), std::move(receiver));
  }

  void Get(const std::string& frame_url,
           const std::string& top_origin,
           GetCallback callback) override {
    ScriptletSource source = g_scriptlet_source.load(std::memory_order_acquire);
    const GURL url(frame_url);
    char* script = source && url.SchemeIsHTTPOrHTTPS()
                       ? source(url.spec().c_str(), top_origin.c_str())
                       : nullptr;
    std::move(callback).Run(script ? std::string(script) : std::string());
    free(script);
  }

 private:
  mojo::ReceiverSet<mojom::NNScriptlets> receivers_;
};

}  // namespace

void SetContentSecurityPolicySource(ContentSecurityPolicySource source) {
  g_csp_source.store(source, std::memory_order_release);
}

void SetScriptletSource(ScriptletSource source) {
  g_scriptlet_source.store(source, std::memory_order_release);
}

void ExposeScriptlets(service_manager::BinderRegistry* registry) {
  registry->AddInterface<mojom::NNScriptlets>(
      base::BindRepeating(&ScriptletsHost::Bind), ScriptletTaskRunner());
}

bool HasRequestFilter() {
  return g_filter.load(std::memory_order_acquire) != nullptr;
}

bool ShouldBlockWebSocket(content::RenderFrameHost* frame,
                         const GURL& url,
                         const net::SiteForCookies& site_for_cookies) {
  RequestFilter filter = g_filter.load(std::memory_order_acquire);
  if (!filter) {
    return false;
  }
  const url::Origin origin = frame
                                 ? frame->GetLastCommittedOrigin()
                                 : url::Origin::Create(
                                       site_for_cookies.RepresentativeUrl());
  if (!origin.opaque() && !origin.GetURL().SchemeIsHTTPOrHTTPS()) {
    return false;
  }
  const std::string source = OriginURL(origin);
  const std::string top =
      frame ? OriginURL(frame->GetOutermostMainFrame()->GetLastCommittedOrigin())
            : source;
  return filter(url.spec().c_str(), source.c_str(), top.c_str(), "websocket",
                "GET", nullptr);
}

void SetRequestFilter(RequestFilter filter) {
  g_filter.store(filter, std::memory_order_release);
}

void MaybeFilterURLLoaderFactory(
    content::ContentBrowserClient::URLLoaderFactoryType type,
    const url::Origin& request_initiator,
    const net::IsolationInfo& isolation_info,
    network::URLLoaderFactoryBuilder& factory_builder,
    content::RenderFrameHost* frame) {
  using Type = content::ContentBrowserClient::URLLoaderFactoryType;
  bool navigation = false;
  switch (type) {
    case Type::kNavigation:
      // Only for rewrites ($removeparam): navigations are blocked by RequestFilterThrottle.
      navigation = true;
      break;
    case Type::kDocumentSubResource:
    case Type::kWorkerMainResource:
    case Type::kWorkerSubResource:
    case Type::kServiceWorkerScript:
    case Type::kServiceWorkerSubResource:
      break;
    default:
      // Downloads, prefetches, DevTools and early hints.
      return;
  }
  // Only web pages' requests: an extension's, or one of Chrome's pages', aren't the blocker's.
  // A navigation is, wherever it starts (the app's address bar included).
  const GURL initiator = request_initiator.GetURL();
  if (!navigation && !request_initiator.opaque() && !initiator.SchemeIsHTTPOrHTTPS()) {
    return;
  }
  std::string top;
  if (isolation_info.top_frame_origin()) {
    top = OriginURL(*isolation_info.top_frame_origin());
  }
  auto [receiver, target] = factory_builder.Append();
  FilterTaskRunner()->PostTask(
      FROM_HERE,
      base::BindOnce(&FilteringFactory::Create, std::move(receiver), std::move(target),
                     OriginURL(request_initiator), std::move(top),
                     frame ? std::make_optional(frame->GetGlobalId())
                           : std::nullopt,
                     navigation));
}

void MaybeAddRequestFilterThrottle(content::NavigationThrottleRegistry& registry) {
  // A fenced frame's root is a main frame of its own tree, but it's a page's frame.
  if (registry.GetNavigationHandle().IsInOutermostMainFrame()) {
    registry.AddThrottle(std::make_unique<MainFrameThrottle>(registry));
  } else {
    registry.AddThrottle(std::make_unique<RequestFilterThrottle>(registry));
  }
}

}  // namespace nncore
