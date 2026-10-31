#include "bay/core/nn_request_filter.h"

#include <atomic>
#include <memory>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/render_frame_host.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/isolation_info.h"
#include "net/base/net_errors.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/cpp/url_loader_factory_builder.h"
#include "services/network/public/mojom/fetch_api.mojom-shared.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"
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
  using Destination = network::mojom::RequestDestination;
  switch (request.destination) {
    case Destination::kScript:
    case Destination::kWorker:
    case Destination::kSharedWorker:
    case Destination::kServiceWorker:
    case Destination::kAudioWorklet:
    case Destination::kPaintWorklet:
    case Destination::kSharedStorageWorklet:
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

// One URLLoaderFactory's interceptor: a blocked request is answered at once with
// ERR_BLOCKED_BY_CLIENT; any other goes to the next factory untouched (its loader and client
// are passed straight through, so nothing more of it comes here). Owns itself: it goes when
// its last receiver or its target does.
class FilteringFactory : public network::mojom::URLLoaderFactory {
 public:
  static void Create(
      mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
      mojo::PendingRemote<network::mojom::URLLoaderFactory> target,
      std::string source,
      std::string top) {
    new FilteringFactory(std::move(receiver), std::move(target), std::move(source),
                         std::move(top));
  }

  FilteringFactory(const FilteringFactory&) = delete;
  FilteringFactory& operator=(const FilteringFactory&) = delete;

  // network::mojom::URLLoaderFactory:
  void CreateLoaderAndStart(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& traffic_annotation)
      override {
    if (ShouldBlock(request)) {
      mojo::Remote<network::mojom::URLLoaderClient>(std::move(client))
          ->OnComplete(
              network::URLLoaderCompletionStatus(net::ERR_BLOCKED_BY_CLIENT));
      return;
    }
    target_->CreateLoaderAndStart(std::move(loader), request_id, options, request,
                                  std::move(client), traffic_annotation);
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
      std::string top)
      : target_(std::move(target)), source_(std::move(source)), top_(std::move(top)) {
    receivers_.Add(this, std::move(receiver));
    receivers_.set_disconnect_handler(base::BindRepeating(
        &FilteringFactory::OnReceiverGone, base::Unretained(this)));
    target_.set_disconnect_handler(
        base::BindOnce(&FilteringFactory::Destroy, base::Unretained(this)));
  }

  ~FilteringFactory() override = default;

  bool ShouldBlock(const network::ResourceRequest& request) const {
    RequestFilter filter = g_filter.load(std::memory_order_acquire);
    if (!filter || !IsWeb(request.url)) {
      return false;
    }
    std::string source;
    if (request.request_initiator) {
      source = OriginURL(*request.request_initiator);
    }
    if (source.empty()) {
      source = source_;
    }
    const std::string& top = top_.empty() ? source : top_;
    return filter(request.url.spec().c_str(), source.c_str(), top.c_str(),
                  TypeOf(request));
  }

  void OnReceiverGone() {
    if (receivers_.empty()) {
      Destroy();
    }
  }

  void Destroy() { delete this; }

  mojo::ReceiverSet<network::mojom::URLLoaderFactory> receivers_;
  mojo::Remote<network::mojom::URLLoaderFactory> target_;
  // The factory's document or worker (its origin), and the page it's in.
  const std::string source_;
  const std::string top_;
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
    return filter(url.spec().c_str(), source.c_str(), top.c_str(), "subdocument")
               ? BLOCK_REQUEST_AND_COLLAPSE
               : PROCEED;
  }
};

}  // namespace

void SetRequestFilter(RequestFilter filter) {
  g_filter.store(filter, std::memory_order_release);
}

void MaybeFilterURLLoaderFactory(
    content::ContentBrowserClient::URLLoaderFactoryType type,
    const url::Origin& request_initiator,
    const net::IsolationInfo& isolation_info,
    network::URLLoaderFactoryBuilder& factory_builder) {
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
                     OriginURL(request_initiator), std::move(top)));
}

void MaybeAddRequestFilterThrottle(content::NavigationThrottleRegistry& registry) {
  if (!registry.GetNavigationHandle().IsInMainFrame()) {
    registry.AddThrottle(std::make_unique<RequestFilterThrottle>(registry));
  }
}

}  // namespace nncore
