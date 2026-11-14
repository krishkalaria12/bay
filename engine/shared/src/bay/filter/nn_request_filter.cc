#include "bay/filter/nn_request_filter.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/byte_size.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "base/values.h"
#include "base/task/bind_post_task.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/shared_cors_origin_access_list.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/simple_watcher.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "bay/filter/mojom/scriptlets.mojom.h"
#include "base/json/json_writer.h"
#include "net/base/data_url.h"
#include "net/base/ip_address.h"
#include "net/base/isolation_info.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/cookies/canonical_cookie.h"
#include "net/cookies/cookie_access_result.h"
#include "net/cookies/cookie_options.h"
#include "net/cookies/cookie_partition_key_collection.h"
#include "net/cookies/cookie_util.h"
#include "net/cookies/site_for_cookies.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_status_code.h"
#include "net/http/http_util.h"
#include "net/url_request/redirect_info.h"
#include "net/url_request/redirect_util.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/cors/cors.h"
#include "services/network/public/cpp/cors/origin_access_list.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/cpp/url_loader_factory_builder.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
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
std::atomic<ResponseFilter> g_response_filter{nullptr};
std::atomic<BodyFilterGate> g_body_filter_gate{nullptr};
std::atomic<BodyFilter> g_body_filter{nullptr};
std::atomic<RequestHeaderNames> g_request_header_names{nullptr};
std::atomic<RequestHeaderFilter> g_request_header_filter{nullptr};
std::atomic<CnameFilter> g_cname_filter{nullptr};

// As uBO: past this, a response isn't held, only passed along.
constexpr size_t kMaxBodyToFilter = 10 * 1024 * 1024;
// The most read from or written to a pipe at a time.
constexpr size_t kBodyChunk = 64 * 1024;
// The pipe a held body is written to; the network service's own default.
constexpr uint32_t kBodyPipeCapacity = 512 * 1024;

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
  // one, a URL to load instead (its tracking parameters removed, or a $urlskip target).
  std::string redirect;
  // Whether redirect may load from another origin (a $urlskip from a redirect tracker).
  bool rewrite_any_origin = false;
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
  bool any_origin = false;
  Decision result;
  result.blocked =
      filter(request.url.spec().c_str(), context.source.c_str(), context.top.c_str(),
             TypeOf(request), request.method.c_str(), &redirect, &any_origin);
  if (redirect) {
    result.redirect = redirect;
    free(redirect);
  }
  result.rewrite_any_origin = any_origin;
  return result;
}

// The URL an allowed request loads instead (a $removeparam rewrite or a $urlskip target): a
// web URL that differs from `url`. A $urlskip may cross origins; a $removeparam stays put.
GURL RewriteOf(const Decision& decision, const GURL& url) {
  if (decision.blocked || decision.redirect.empty()) {
    return GURL();
  }
  GURL rewritten(decision.redirect);
  if (!rewritten.is_valid() || !rewritten.SchemeIsHTTPOrHTTPS() || rewritten == url) {
    return GURL();
  }
  if (!decision.rewrite_any_origin && !url::IsSameOriginWith(rewritten, url)) {
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

// Headers as [["Name", "value"], ...], for the host's rules.
void AppendHeader(base::ListValue& list, std::string_view name, std::string_view value) {
  base::ListValue pair;
  pair.Append(name);
  pair.Append(value);
  list.Append(std::move(pair));
}

std::string HeadersJSON(const net::HttpResponseHeaders& headers) {
  base::ListValue list;
  size_t at = 0;
  std::string name, value;
  while (headers.EnumerateHeaderLines(&at, &name, &value)) {
    AppendHeader(list, name, value);
  }
  return base::WriteJson(list).value_or("[]");
}

// The response's remote address, or an empty string for an in-process or cached response.
std::string RemoteAddress(const network::mojom::URLResponseHead& head) {
  const net::IPAddress& address = head.remote_endpoint.address();
  return address.IsValid() && !address.IsZero() ? address.ToString() : std::string();
}

// What the host's response rules did to a response.
struct ResponseVerdict {
  bool blocked = false;
  // For a blocked response, a data URL answered in its place.
  std::string stand_in;
  // Whether ##^responseheader(location) took the redirect's target.
  bool removed_location = false;
};

// Applies the host's response rules ($header, $ipaddress, $permissions, ##^responseheader). Changes are
// made on a copy of the headers, then parsed headers are cleared so Chrome parses them again (as for a
// webRequest extension's changes).
ResponseVerdict ApplyResponseFilter(const network::ResourceRequest& request,
                                    const std::string& factory_source,
                                    const std::string& factory_top,
                                    network::mojom::URLResponseHead& head) {
  ResponseVerdict verdict;
  ResponseFilter filter = g_response_filter.load(std::memory_order_acquire);
  if (!filter || !head.headers || !request.url.SchemeIsHTTPOrHTTPS()) {
    return verdict;
  }
  const RequestContext context = ContextOf(request, factory_source, factory_top);
  const std::string ip = RemoteAddress(head);
  const std::string headers = HeadersJSON(*head.headers);
  char* answer = filter(request.url.spec().c_str(), context.source.c_str(),
                        context.top.c_str(), TypeOf(request), request.method.c_str(),
                        ip.empty() ? nullptr : ip.c_str(), headers.c_str());
  if (!answer) {
    return verdict;
  }
  std::optional<base::DictValue> result =
      base::JSONReader::ReadDict(answer, base::JSON_PARSE_RFC);
  free(answer);
  if (!result) {
    return verdict;
  }
  if (result->FindBool("blocked").value_or(false)) {
    verdict.blocked = true;
    if (const std::string* redirect = result->FindString("redirect")) {
      verdict.stand_in = *redirect;
    }
    return verdict;
  }
  bool changed = false;
  auto updated =
      base::MakeRefCounted<net::HttpResponseHeaders>(head.headers->raw_headers());
  if (const base::ListValue* remove = result->FindList("remove")) {
    for (const base::Value& name : *remove) {
      if (!name.is_string()) {
        continue;
      }
      // The trusted header client removes Set-Cookie before storage. These
      // headers cross Mojo without it, so no cookie-store cleanup belongs here.
      if (base::EqualsCaseInsensitiveASCII(name.GetString(), "set-cookie")) {
        continue;
      }
      if (!updated->HasHeader(name.GetString())) {
        continue;
      }
      verdict.removed_location |= base::EqualsCaseInsensitiveASCII(name.GetString(), "location");
      updated->RemoveHeader(name.GetString());
      changed = true;
    }
  }
  if (const base::ListValue* add = result->FindList("add")) {
    for (const base::Value& item : *add) {
      if (!item.is_list() || item.GetList().size() != 2) {
        continue;
      }
      const base::ListValue& pair = item.GetList();
      if (!pair[0].is_string() || !pair[1].is_string()) {
        continue;
      }
      updated->AddHeader(pair[0].GetString(), pair[1].GetString());
      changed = true;
    }
  }
  if (changed) {
    head.headers = std::move(updated);
    head.parsed_headers.reset();
  }
  return verdict;
}

// ##^responseheader(set-cookie) is a host rule, independent of the response's
// headers or address. The trusted header hook calls this before cookie storage.
bool DiscardsResponseCookies(const network::ResourceRequest& request,
                             const std::string& factory_source,
                             const std::string& factory_top) {
  ResponseFilter filter = g_response_filter.load(std::memory_order_acquire);
  if (!filter || !request.url.SchemeIsHTTPOrHTTPS()) {
    return false;
  }
  const RequestContext context = ContextOf(request, factory_source, factory_top);
  char* answer = filter(request.url.spec().c_str(), context.source.c_str(),
                        context.top.c_str(), TypeOf(request), request.method.c_str(),
                        nullptr, "[]");
  if (!answer) {
    return false;
  }
  std::optional<base::DictValue> result =
      base::JSONReader::ReadDict(answer, base::JSON_PARSE_RFC);
  free(answer);
  const base::ListValue* removed = result ? result->FindList("remove") : nullptr;
  return removed && std::ranges::any_of(*removed, [](const base::Value& name) {
    return name.is_string() &&
           base::EqualsCaseInsensitiveASCII(name.GetString(), "set-cookie");
  });
}

// The Cookie header a request will carry, which the network service only adds after this interceptor:
// the cookies Chrome would send for the URL, as a site's own requests get them. On the UI thread;
// `done` always runs, with "" when the frame has gone.
void ReadCookies(content::GlobalRenderFrameHostId frame,
                 network::ResourceRequest request,
                 const GURL& credentials_url,
                 base::OnceCallback<void(std::string)> done) {
  content::RenderFrameHost* host = content::RenderFrameHost::FromID(frame);
  if (!host) {
    return std::move(done).Run(std::string());
  }
  // CorsURLLoader resolves same-origin credentials only after this interceptor.
  // Honor its origin exemptions too, including extension isolated worlds.
  if (request.credentials_mode == network::mojom::CredentialsMode::kSameOrigin &&
      request.request_initiator && !request.request_initiator->IsSameOriginWith(credentials_url)) {
    const auto& access = host->GetBrowserContext()
                             ->GetSharedCorsOriginAccessList()->GetOriginAccessList();
    if (access.CheckAccessState(request.isolated_world_origin.value_or(*request.request_initiator),
                                credentials_url) != network::cors::OriginAccessList::AccessState::kAllowed) {
      return std::move(done).Run(std::string());
    }
  }
  net::CookieOptions options;
  options.set_include_httponly();
  options.set_same_site_cookie_context(net::cookie_util::ComputeSameSiteContextForSubresource(
      request.url, request.site_for_cookies, /*force_ignore_site_for_cookies=*/false));
  host->GetStoragePartition()->GetCookieManagerForBrowserProcess()->GetCookieList(
      request.url, options, net::CookiePartitionKeyCollection(),
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(
              [](base::OnceCallback<void(std::string)> done,
                 const net::CookieAccessResultList& included,
                 const net::CookieAccessResultList&) {
                std::move(done).Run(net::CanonicalCookie::BuildCookieLine(included));
              },
              std::move(done)),
          net::CookieAccessResultList(), net::CookieAccessResultList()));
}

// A response body on its way to the host's body filter, away from the filter's sequence: rewriting one
// takes far longer than the checks that sequence is meant for.
struct BodyJob {
  BodyFilter filter;
  std::string url;
  std::string source;
  std::string top;
  std::string type;
  std::string method;
  std::string content_type;
  std::string body;
  // Set when the body changed.
  std::optional<std::string> filtered;
};

BodyJob RunBodyFilter(BodyJob job) {
  size_t length = 0;
  uint8_t* filtered =
      job.filter(job.url.c_str(), job.source.c_str(), job.top.c_str(), job.type.c_str(),
                 job.method.c_str(), job.content_type.c_str(),
                 reinterpret_cast<const uint8_t*>(job.body.data()), job.body.size(), &length);
  if (filtered) {
    job.filtered.emplace(reinterpret_cast<const char*>(filtered), length);
    free(filtered);
  }
  return job;
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
//
// A response the host's body rules match ($replace, HTML ##^) stays here until its body has arrived,
// as its headers and every byte depend on the result: the client gets nothing, then the response on a
// new pipe. Past kMaxBodyToFilter, what's held goes to the client unchanged and the rest follows.
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
    CheckRequestHeaders(base::BindOnce(&FilteringLoader::StartNetwork,
                                       weak_factory_.GetWeakPtr()));
  }

  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers,
      const std::optional<GURL>& new_url) override {
    if (new_url) {
      request_.url = *new_url;
    }
    // Keep the saved request in step with the network loader. A later blocker rewrite
    // starts a new loader from it, so an earlier redirect's removed credentials must
    // not return, and header rules must see the headers that will actually be sent.
    for (const std::string& header : headers.removed_headers) {
      request_.headers.RemoveHeader(header);
      request_.cors_exempt_headers.RemoveHeader(header);
    }
    request_.headers.MergeFrom(headers.modified_headers);
    request_.cors_exempt_headers.MergeFrom(headers.modified_cors_exempt_headers);
    if (restart_pending_) {
      // The client followed a redirect this loader made: the request starts again there.
      restart_pending_ = false;
      if (!navigation_) {
        const Decision decision = Match(request_, source_, top_);
        if (decision.blocked) {
          return Block(decision);
        }
      }
      return CheckRequestHeaders(base::BindOnce(&FilteringLoader::StartNetwork,
                                                weak_factory_.GetWeakPtr()));
    }
    if (new_url && !navigation_) {
      const Decision decision = Match(request_, source_, top_);
      if (decision.blocked) {
        return Block(decision);
      }
    }
    CheckRequestHeaders(base::BindOnce(&FilteringLoader::FollowTargetRedirect,
                                       weak_factory_.GetWeakPtr(), std::move(headers),
                                       new_url));
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
    if (BlockedByCname(*head)) {
      return Block({.blocked = true});
    }
    const ResponseVerdict verdict = ApplyResponseFilter(request_, source_, top_, *head);
    if (verdict.blocked) {
      return Block({.blocked = true, .redirect = verdict.stand_in});
    }
    if (navigation_) {
      AddContentSecurityPolicy(request_, source_, top_, *head);
    }
    if (body.is_valid() && WantsBody(*head)) {
      return HoldBody(std::move(head), std::move(body), std::move(metadata));
    }
    client_->OnReceiveResponse(std::move(head), std::move(body),
                               std::move(metadata));
  }

  void OnReceiveRedirect(const net::RedirectInfo& redirect,
                         network::mojom::URLResponseHeadPtr head) override {
    // Keep the redirect limit across blocker rewrites, which restart the loader.
    if (server_redirects_++ == 20) {
      client_->OnComplete(network::URLLoaderCompletionStatus(net::ERR_TOO_MANY_REDIRECTS));
      return Destroy();
    }
    // CORS remains in force after a cross-origin hop, even when a later redirect
    // returns to the initiator. Preserve that decision if we restart the loader.
    force_omit_same_origin_credentials_ |= head->response_type == network::mojom::FetchResponseType::kCors;
    if (BlockedByCname(*head)) {
      return Block({.blocked = true});
    }
    // uBO checks a redirect's headers too: a $header rule can stop a redirect tracker.
    const ResponseVerdict verdict = ApplyResponseFilter(request_, source_, top_, *head);
    if (verdict.blocked) {
      return Block({.blocked = true, .redirect = verdict.stand_in});
    }
    if (verdict.removed_location) {
      return EndAtRedirect(std::move(head));
    }
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
    UpdateRequestOnRedirect(redirect);
    client_->OnReceiveRedirect(redirect, std::move(head));
  }

  void OnUploadProgress(int64_t current,
                        int64_t total,
                        OnUploadProgressCallback callback) override {
    client_->OnUploadProgress(current, total, std::move(callback));
  }

  void OnTransferSizeUpdated(int32_t delta) override {
    // A client hears of these after its response, and a held one hasn't got it yet.
    if (head_) {
      held_transfer_size_ += delta;
    } else {
      client_->OnTransferSizeUpdated(delta);
    }
  }

  void OnComplete(const network::URLLoaderCompletionStatus& status) override {
    if (!holding_body_) {
      client_->OnComplete(status);
      return Destroy();
    }
    // The body may still be arriving, or on its way to the client.
    completion_ = status;
    network_client_.set_disconnect_handler(base::DoNothing());
    if (!body_source_.is_valid() && !writing_ && !filtering_) {
      FilterHeldBody();
    } else if (writing_ && !producer_.is_valid()) {
      Finish();
    }
  }

 private:
  // Each rewrite removes parameters, so a chain ends; this bounds one a server keeps redirecting.
  static constexpr int kMaxRewrites = 3;

  ~FilteringLoader() override = default;

  void StartNetwork();

  void UpdateRequestOnRedirect(const net::RedirectInfo& info) {
    bool clear_body = false;
    net::RedirectUtil::UpdateHttpRequest(
        request_.url, request_.method, info, std::nullopt, std::nullopt,
        &request_.headers, &clear_body);
    bool clear_cors_exempt_body = false;
    net::RedirectUtil::UpdateHttpRequest(
        request_.url, request_.method, info, std::nullopt, std::nullopt,
        &request_.cors_exempt_headers, &clear_cors_exempt_body);
    if (clear_body || clear_cors_exempt_body) {
      request_.request_body.reset();
    }
    request_.UpdateOnRedirect(info);
  }

  void FollowTargetRedirect(network::HttpRequestHeadersUpdateParams headers,
                            const std::optional<GURL>& new_url) {
    target_->FollowRedirect(std::move(headers), new_url);
  }

  // $requestheader: runs `next` unless the request's headers are refused. Cookie isn't among them
  // yet (the network service adds it), so a rule that reads it waits for the cookie store.
  void CheckRequestHeaders(base::OnceClosure next) {
    RequestHeaderNames names = g_request_header_names.load(std::memory_order_acquire);
    if (!names || navigation_ || !request_.url.SchemeIsHTTPOrHTTPS()) {
      return std::move(next).Run();
    }
    const RequestContext context = ContextOf(request_, source_, top_);
    char* wanted = names(request_.url.spec().c_str(), context.source.c_str(), context.top.c_str(),
                         TypeOf(request_), request_.method.c_str());
    if (!wanted) {
      return std::move(next).Run();
    }
    const bool reads_cookie = std::string_view(wanted).find("\"cookie\"") != std::string::npos;
    free(wanted);
    if (!reads_cookie || !frame_ || (request_.load_flags & net::LOAD_DO_NOT_SEND_COOKIES) ||
        !network::cors::CalculateCredentialsFlag(
            request_.credentials_mode, force_omit_same_origin_credentials_
                                           ? network::mojom::FetchResponseType::kCors
                                           : network::mojom::FetchResponseType::kBasic)) {
      return FinishRequestHeaders(std::move(next), std::string());
    }
    // Unlike CORS redirects, no-CORS redirects keep the network loader's
    // initial credentials decision (CorsURLLoader::FollowRedirect).
    const GURL credentials_url = request_.mode == network::mojom::RequestMode::kNoCors && target_.is_bound()
                                     ? network_credentials_url_ : request_.url;
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE,
        base::BindOnce(&ReadCookies, *frame_, request_, credentials_url,
                       base::BindPostTaskToCurrentDefault(base::BindOnce(
                           &FilteringLoader::FinishRequestHeaders,
                           weak_factory_.GetWeakPtr(), std::move(next)))));
  }

  void FinishRequestHeaders(base::OnceClosure next, std::string cookie) {
    RequestHeaderFilter filter = g_request_header_filter.load(std::memory_order_acquire);
    if (!filter) {
      return std::move(next).Run();
    }
    base::ListValue headers;
    for (const net::HttpRequestHeaders* set : {&request_.headers, &request_.cors_exempt_headers}) {
      for (const net::HttpRequestHeaders::HeaderKeyValuePair& header : set->GetHeaderVector()) {
        AppendHeader(headers, header.key, header.value);
      }
    }
    if (request_.referrer.is_valid()) {
      AppendHeader(headers, "Referer", request_.referrer.spec());
    }
    if (!cookie.empty()) {
      AppendHeader(headers, "Cookie", cookie);
    }
    const RequestContext context = ContextOf(request_, source_, top_);
    const std::string json = base::WriteJson(headers).value_or("[]");
    if (filter(request_.url.spec().c_str(), context.source.c_str(), context.top.c_str(),
               TypeOf(request_), request_.method.c_str(), json.c_str())) {
      return Block({.blocked = true});
    }
    std::move(next).Run();
  }

  // Whether what the request's hostname is a CNAME of is blocked: uBO's uncloaking, but only from the
  // answer the network stack got, so once the request has gone.
  bool BlockedByCname(const network::mojom::URLResponseHead& head) {
    CnameFilter filter = g_cname_filter.load(std::memory_order_acquire);
    if (!filter || head.dns_aliases.empty() || !request_.url.SchemeIsHTTPOrHTTPS()) {
      return false;
    }
    const RequestContext context = ContextOf(request_, source_, top_);
    for (const std::string& alias : head.dns_aliases) {
      if (filter(request_.url.spec().c_str(), alias.c_str(), context.source.c_str(),
                 context.top.c_str(), TypeOf(request_), request_.method.c_str())) {
        return true;
      }
    }
    return false;
  }

  // ##^responseheader(location) took a redirect's target, which the network stack has already read:
  // the redirect ends here, as a response of its own, as it would had the header not been there.
  void EndAtRedirect(network::mojom::URLResponseHeadPtr head) {
    network_client_.reset();
    target_.reset();
    mojo::ScopedDataPipeProducerHandle producer;
    mojo::ScopedDataPipeConsumerHandle consumer;
    if (mojo::CreateDataPipe(nullptr, producer, consumer) != MOJO_RESULT_OK) {
      client_->OnComplete(
          network::URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      return Destroy();
    }
    // A navigation without a type would be a download.
    if (head->mime_type.empty()) {
      head->mime_type = "text/html";
    }
    head->content_length = 0;
    client_->OnReceiveResponse(std::move(head), std::move(consumer), std::nullopt);
    client_->OnComplete(network::URLLoaderCompletionStatus(net::OK));
    Destroy();
  }

  // Whether the host's body rules want this response. A body the renderer would decode itself isn't
  // readable text here, and that's an off-by-default feature of Chrome's.
  bool WantsBody(const network::mojom::URLResponseHead& head) {
    BodyFilterGate gate = g_body_filter_gate.load(std::memory_order_acquire);
    if (!gate || !g_body_filter.load(std::memory_order_acquire) || !head.headers ||
        !request_.url.SchemeIsHTTPOrHTTPS() ||
        !head.client_side_content_decoding_types.empty()) {
      return false;
    }
    const RequestContext context = ContextOf(request_, source_, top_);
    const std::string disposition =
        head.headers->GetNormalizedHeader("Content-Disposition").value_or(std::string());
    return gate(request_.url.spec().c_str(), context.source.c_str(), context.top.c_str(),
                TypeOf(request_), request_.method.c_str(), head.headers->response_code(),
                ContentTypeOf(head).c_str(), disposition.c_str());
  }

  static std::string ContentTypeOf(const network::mojom::URLResponseHead& head) {
    return head.headers->GetNormalizedHeader("Content-Type").value_or(head.mime_type);
  }

  void HoldBody(network::mojom::URLResponseHeadPtr head,
                mojo::ScopedDataPipeConsumerHandle body,
                std::optional<mojo_base::BigBuffer> metadata) {
    holding_body_ = true;
    head_ = std::move(head);
    metadata_ = std::move(metadata);
    body_source_ = std::move(body);
    source_watcher_.Watch(
        body_source_.get(), MOJO_HANDLE_SIGNAL_READABLE | MOJO_HANDLE_SIGNAL_PEER_CLOSED,
        base::BindRepeating(&FilteringLoader::OnPipeReady, base::Unretained(this)));
    Pump();
  }

  void OnPipeReady(MojoResult result) {
    if (result != MOJO_RESULT_CANCELLED) {
      Pump();
    }
  }

  // Moves the body along: while held, from the network's pipe into `pending_`; while writing, from
  // `pending_` to the client's pipe, reading more only as that drains.
  void Pump() {
    while (true) {
      if (writing_ && written_ < pending_.size()) {
        const auto rest = base::as_byte_span(pending_).subspan(written_);
        size_t count = 0;
        const MojoResult result = producer_->WriteData(rest.first(std::min(rest.size(), kBodyChunk)),
                                                       MOJO_WRITE_DATA_FLAG_NONE, count);
        if (result == MOJO_RESULT_SHOULD_WAIT) {
          producer_watcher_.ArmOrNotify();
          return;
        }
        if (result != MOJO_RESULT_OK) {
          // The client stopped reading. It can still hear how the request ended.
          pending_.clear();
          written_ = 0;
          source_watcher_.Cancel();
          body_source_.reset();
          continue;
        }
        written_ += count;
        continue;
      }
      if (!body_source_.is_valid()) {
        if (!writing_) {
          return FilterHeldBody();
        }
        producer_watcher_.Cancel();
        producer_.reset();
        return Finish();
      }
      if (writing_) {
        pending_.clear();
        written_ = 0;
      }
      const size_t held = pending_.size();
      pending_.resize(held + kBodyChunk);
      size_t count = 0;
      const MojoResult result = body_source_->ReadData(
          MOJO_READ_DATA_FLAG_NONE,
          base::as_writable_byte_span(pending_).subspan(held), count);
      pending_.resize(held + (result == MOJO_RESULT_OK ? count : 0));
      if (result == MOJO_RESULT_SHOULD_WAIT) {
        source_watcher_.ArmOrNotify();
        return;
      }
      if (result != MOJO_RESULT_OK) {
        source_watcher_.Cancel();
        body_source_.reset();
        continue;
      }
      if (!writing_ && pending_.size() > kMaxBodyToFilter && !ReleaseResponse()) {
        return;
      }
    }
  }

  // Once all of a held body and the request's outcome are in: a response that failed goes as it came.
  void FilterHeldBody() {
    if (!completion_) {
      return;
    }
    BodyFilter filter = g_body_filter.load(std::memory_order_acquire);
    if (!filter || completion_->error_code != net::OK) {
      if (ReleaseResponse()) {
        Pump();
      }
      return;
    }
    filtering_ = true;
    const RequestContext context = ContextOf(request_, source_, top_);
    BodyJob job{.filter = filter,
                .url = request_.url.spec(),
                .source = context.source,
                .top = context.top,
                .type = TypeOf(request_),
                .method = request_.method,
                .content_type = ContentTypeOf(*head_),
                .body = std::move(pending_)};
    pending_.clear();
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE,
        {base::TaskPriority::USER_BLOCKING, base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
        base::BindOnce(&RunBodyFilter, std::move(job)),
        base::BindOnce(&FilteringLoader::OnBodyFiltered, weak_factory_.GetWeakPtr()));
  }

  void OnBodyFiltered(BodyJob job) {
    filtering_ = false;
    if (job.filtered) {
      pending_ = std::move(*job.filtered);
      // The network service's Content-Encoding is long undone, and its length is the old body's.
      auto updated =
          base::MakeRefCounted<net::HttpResponseHeaders>(head_->headers->raw_headers());
      updated->RemoveHeader("Content-Length");
      head_->headers = std::move(updated);
      head_->content_length = pending_.size();
      // Code cached from the old text: V8 only compares a script's length.
      metadata_.reset();
      completion_->decoded_body_length = base::ByteSize(pending_.size());
    } else {
      pending_ = std::move(job.body);
    }
    if (ReleaseResponse()) {
      Pump();
    }
  }

  // Gives the client its response, on a new pipe for what's in `pending_`. False when the loader went.
  bool ReleaseResponse() {
    const MojoCreateDataPipeOptions options{sizeof(MojoCreateDataPipeOptions),
                                            MOJO_CREATE_DATA_PIPE_FLAG_NONE, 1,
                                            kBodyPipeCapacity};
    mojo::ScopedDataPipeConsumerHandle consumer;
    if (mojo::CreateDataPipe(&options, producer_, consumer) != MOJO_RESULT_OK) {
      client_->OnComplete(
          network::URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      Destroy();
      return false;
    }
    producer_watcher_.Watch(
        producer_.get(), MOJO_HANDLE_SIGNAL_WRITABLE | MOJO_HANDLE_SIGNAL_PEER_CLOSED,
        base::BindRepeating(&FilteringLoader::OnPipeReady, base::Unretained(this)));
    writing_ = true;
    written_ = 0;
    client_->OnReceiveResponse(std::move(head_), std::move(consumer), std::move(metadata_));
    if (held_transfer_size_) {
      client_->OnTransferSizeUpdated(held_transfer_size_);
      held_transfer_size_ = 0;
    }
    return true;
  }

  // The body is with the client: the request ends when the network says how.
  void Finish() {
    if (completion_) {
      client_->OnComplete(*completion_);
      Destroy();
    }
  }

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
    UpdateRequestOnRedirect(info);
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
  int server_redirects_ = 0;
  bool force_omit_same_origin_credentials_ = false;
  GURL network_credentials_url_;

  // A held response (HoldBody). `head_` and `metadata_` wait until ReleaseResponse; `pending_` is the
  // whole body until then, and after it what's next to write, of which `written_` have gone.
  bool holding_body_ = false;
  bool filtering_ = false;
  bool writing_ = false;
  network::mojom::URLResponseHeadPtr head_;
  std::optional<mojo_base::BigBuffer> metadata_;
  int32_t held_transfer_size_ = 0;
  std::string pending_;
  size_t written_ = 0;
  std::optional<network::URLLoaderCompletionStatus> completion_;
  mojo::ScopedDataPipeConsumerHandle body_source_;
  mojo::ScopedDataPipeProducerHandle producer_;
  mojo::SimpleWatcher source_watcher_{FROM_HERE, mojo::SimpleWatcher::ArmingPolicy::MANUAL};
  mojo::SimpleWatcher producer_watcher_{FROM_HERE, mojo::SimpleWatcher::ArmingPolicy::MANUAL};

  base::WeakPtrFactory<FilteringLoader> weak_factory_{this};
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
  std::optional<network::ResourceRequest> credentialless_request;
  network_credentials_url_ = request_.url;
  if (force_omit_same_origin_credentials_ &&
      request_.credentials_mode == network::mojom::CredentialsMode::kSameOrigin) {
    credentialless_request = request_;
    credentialless_request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  }
  factory_->target()->CreateLoaderAndStart(
      target_.BindNewPipeAndPassReceiver(), request_id_,
      options_ | network::mojom::kURLLoadOptionUseHeaderClient,
      credentialless_request ? *credentialless_request : request_,
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
                  navigation->IsPost() ? "POST" : "GET", nullptr, nullptr)
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
                                  method, nullptr, nullptr)) {
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
    if (!filter(url.c_str(), url.c_str(), url.c_str(), "document", method, nullptr,
                nullptr)) {
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

void SetResponseFilter(ResponseFilter filter) {
  g_response_filter.store(filter, std::memory_order_release);
}

void SetBodyFilter(BodyFilterGate gate, BodyFilter filter) {
  g_body_filter.store(filter, std::memory_order_release);
  g_body_filter_gate.store(gate, std::memory_order_release);
}

void SetRequestHeaderFilter(RequestHeaderNames names, RequestHeaderFilter filter) {
  g_request_header_filter.store(filter, std::memory_order_release);
  g_request_header_names.store(names, std::memory_order_release);
}

void SetCnameFilter(CnameFilter filter) {
  g_cname_filter.store(filter, std::memory_order_release);
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
                "GET", nullptr, nullptr);
}

void SetRequestFilter(RequestFilter filter) {
  g_filter.store(filter, std::memory_order_release);
}

ResponseCookieFilterInstaller MaybeFilterURLLoaderFactory(
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
      return {};
  }
  // Only web pages' requests: an extension's, or one of Chrome's pages', aren't the blocker's.
  // A navigation is, wherever it starts (the app's address bar included).
  const GURL initiator = request_initiator.GetURL();
  if (!navigation && !request_initiator.opaque() && !initiator.SchemeIsHTTPOrHTTPS()) {
    return {};
  }
  std::string top;
  if (isolation_info.top_frame_origin()) {
    top = OriginURL(*isolation_info.top_frame_origin());
  }
  const bool main_frame = navigation && (!frame || !frame->GetParentOrOuterDocument());
  auto policy = base::BindRepeating(
      [](std::string source, std::string top, bool main_frame, const GURL& url) {
        network::ResourceRequest request;
        request.url = url;
        if (main_frame) {
          request.destination = network::mojom::RequestDestination::kDocument;
        }
        return DiscardsResponseCookies(request, source, top);
      },
      OriginURL(request_initiator), top, main_frame);
  auto [receiver, target] = factory_builder.Append();
  FilterTaskRunner()->PostTask(
      FROM_HERE,
      base::BindOnce(&FilteringFactory::Create, std::move(receiver), std::move(target),
                     OriginURL(request_initiator), std::move(top),
                     frame ? std::make_optional(frame->GetGlobalId())
                           : std::nullopt,
                     navigation));
  return base::BindOnce(
      [](ResponseCookiePolicy policy, scoped_refptr<base::SequencedTaskRunner> runner,
         mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>* client) {
        WrapResponseCookieFilter(client, std::move(policy), std::move(runner));
      },
      std::move(policy), FilterTaskRunner());
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
