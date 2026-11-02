#include "bay/core/nn_request_filter.h"

#include <atomic>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>

#include "base/byte_size.h"
#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/render_frame_host.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "net/base/data_url.h"
#include "net/base/isolation_info.h"
#include "net/base/net_errors.h"
#include "net/cookies/site_for_cookies.h"
#include "net/http/http_response_headers.h"
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
  std::string redirect;
};

Decision Match(const network::ResourceRequest& request,
               const std::string& factory_source,
               const std::string& factory_top) {
  RequestFilter filter = g_filter.load(std::memory_order_acquire);
  if (!filter || !IsWeb(request.url)) {
    return {};
  }
  std::string source = request.request_initiator
                           ? OriginURL(*request.request_initiator)
                           : std::string();
  if (source.empty()) {
    source = factory_source;
  }
  const std::string& top = factory_top.empty() ? source : factory_top;
  char* redirect = nullptr;
  Decision result;
  result.blocked = filter(request.url.spec().c_str(), source.c_str(), top.c_str(),
                          TypeOf(request), request.method.c_str(), &redirect);
  if (redirect) {
    result.redirect = redirect;
    free(redirect);
  }
  return result;
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

// Keeps the browser between the network service and the renderer until completion.
// A redirect is checked before the renderer can follow it, including an override
// passed through FollowRedirect. Closing either endpoint cancels the request.
class FilteringLoader : public network::mojom::URLLoader,
                        public network::mojom::URLLoaderClient {
 public:
  FilteringLoader(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      network::ResourceRequest request,
      std::string source,
      std::string top,
      std::optional<content::GlobalRenderFrameHostId> frame)
      : receiver_(this, std::move(loader)),
        client_(std::move(client)),
        request_(std::move(request)),
        source_(std::move(source)),
        top_(std::move(top)),
        frame_(frame) {
    receiver_.set_disconnect_handler(
        base::BindOnce(&FilteringLoader::Destroy, base::Unretained(this)));
    client_.set_disconnect_handler(
        base::BindOnce(&FilteringLoader::Destroy, base::Unretained(this)));
  }

  void Start(network::mojom::URLLoaderFactory* factory,
             int32_t request_id,
             uint32_t options,
             const net::MutableNetworkTrafficAnnotationTag& annotation) {
    factory->CreateLoaderAndStart(
        target_.BindNewPipeAndPassReceiver(), request_id, options, request_,
        network_client_.BindNewPipeAndPassRemote(), annotation);
    network_client_.set_disconnect_handler(
        base::BindOnce(&FilteringLoader::NetworkGone, base::Unretained(this)));
  }

  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers,
      const std::optional<GURL>& new_url) override {
    if (new_url) {
      request_.url = *new_url;
      const Decision decision = Match(request_, source_, top_);
      if (decision.blocked) {
        return Block(decision);
      }
    }
    target_->FollowRedirect(std::move(headers), new_url);
  }

  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {
    target_->SetPriority(priority, intra_priority_value);
  }

  void OnReceiveEarlyHints(network::mojom::EarlyHintsPtr hints) override {
    client_->OnReceiveEarlyHints(std::move(hints));
  }

  void OnReceiveResponse(network::mojom::URLResponseHeadPtr head,
                         mojo::ScopedDataPipeConsumerHandle body,
                         std::optional<mojo_base::BigBuffer> metadata) override {
    client_->OnReceiveResponse(std::move(head), std::move(body),
                               std::move(metadata));
  }

  void OnReceiveRedirect(const net::RedirectInfo& redirect,
                         network::mojom::URLResponseHeadPtr head) override {
    request_.url = redirect.new_url;
    request_.method = redirect.new_method;
    const Decision decision = Match(request_, source_, top_);
    if (decision.blocked) {
      return Block(decision);
    }
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
  ~FilteringLoader() override = default;

  void Block(const Decision& decision) {
    CompleteBlocked(client_.Unbind(), decision, frame_, request_.url);
    Destroy();
  }

  void NetworkGone() {
    client_->OnComplete(network::URLLoaderCompletionStatus(net::ERR_FAILED));
    Destroy();
  }

  void Destroy() { delete this; }

  mojo::Receiver<network::mojom::URLLoader> receiver_;
  mojo::Remote<network::mojom::URLLoaderClient> client_;
  mojo::Remote<network::mojom::URLLoader> target_;
  mojo::Receiver<network::mojom::URLLoaderClient> network_client_{this};
  network::ResourceRequest request_;
  const std::string source_;
  const std::string top_;
  const std::optional<content::GlobalRenderFrameHostId> frame_;
};

// One URLLoaderFactory's interceptor: a blocked request is answered at once (an error or a
// stand-in); any other goes to the next factory through a FilteringLoader. Owns itself: it
// goes when its last receiver or its target does.
class FilteringFactory : public network::mojom::URLLoaderFactory {
 public:
  static void Create(
      mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
      mojo::PendingRemote<network::mojom::URLLoaderFactory> target,
      std::string source,
      std::string top,
      std::optional<content::GlobalRenderFrameHostId> frame) {
    new FilteringFactory(std::move(receiver), std::move(target), std::move(source),
                         std::move(top), frame);
  }

  FilteringFactory(const FilteringFactory&) = delete;
  FilteringFactory& operator=(const FilteringFactory&) = delete;

  void CreateLoaderAndStart(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& annotation) override {
    const Decision decision = Match(request, source_, top_);
    if (decision.blocked) {
      return CompleteBlocked(std::move(client), decision, frame_, request.url);
    }
    auto* proxy = new FilteringLoader(std::move(loader), std::move(client),
                                      request, source_, top_, frame_);
    proxy->Start(target_.get(), request_id, options, annotation);
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
      std::optional<content::GlobalRenderFrameHostId> frame)
      : target_(std::move(target)),
        source_(std::move(source)),
        top_(std::move(top)),
        frame_(frame) {
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
};

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

}  // namespace

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
  switch (type) {
    case Type::kDocumentSubResource:
    case Type::kWorkerMainResource:
    case Type::kWorkerSubResource:
    case Type::kServiceWorkerScript:
    case Type::kServiceWorkerSubResource:
      break;
    default:
      // Navigations (subframes go through RequestFilterThrottle), downloads, prefetches,
      // DevTools and early hints.
      return;
  }
  // Only web pages' requests: an extension's, or one of Chrome's pages', aren't the blocker's.
  const GURL initiator = request_initiator.GetURL();
  if (!request_initiator.opaque() && !initiator.SchemeIsHTTPOrHTTPS()) {
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
                           : std::nullopt));
}

void MaybeAddRequestFilterThrottle(content::NavigationThrottleRegistry& registry) {
  if (!registry.GetNavigationHandle().IsInMainFrame()) {
    registry.AddThrottle(std::make_unique<RequestFilterThrottle>(registry));
  }
}

}  // namespace nncore
