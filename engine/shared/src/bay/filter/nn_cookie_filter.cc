#include "bay/filter/nn_cookie_filter.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/task/sequenced_task_runner.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/bindings/self_owned_receiver.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_response_headers.h"
#include "net/ssl/ssl_info.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "url/gurl.h"

namespace nncore {
namespace {

// One network loader, including all of its ordinary server redirects. Existing
// clients decide first; cookie suppression is applied to their final headers.
class CookieHeaderClient : public network::mojom::TrustedHeaderClient {
 public:
  CookieHeaderClient(
      ResponseCookiePolicy policy,
      mojo::PendingRemote<network::mojom::TrustedHeaderClient> target)
      : policy_(std::move(policy)), target_(std::move(target)) {}

  void OnBeforeSendHeaders(const GURL& request_url,
                           const net::HttpRequestHeaders& headers,
                           OnBeforeSendHeadersCallback callback) override {
    url_ = request_url;
    if (target_.is_bound()) {
      target_->OnBeforeSendHeaders(request_url, headers,
                                   mojo::WrapCallbackWithDefaultInvokeIfNotRun(
                                       std::move(callback), net::ERR_FAILED,
                                       std::nullopt, std::nullopt));
    } else {
      std::move(callback).Run(net::OK, std::nullopt, std::nullopt);
    }
  }

  void OnHeadersReceived(const std::string& headers,
                         const net::IPEndPoint& remote_endpoint,
                         const std::optional<net::SSLInfo>& ssl_info,
                         OnHeadersReceivedCallback callback) override {
    if (target_.is_bound()) {
      target_->OnHeadersReceived(
          headers, remote_endpoint, ssl_info,
          mojo::WrapCallbackWithDefaultInvokeIfNotRun(
              base::BindOnce(&CookieHeaderClient::CompleteHeaders,
                             weak_factory_.GetWeakPtr(), std::move(callback),
                             headers),
              net::ERR_FAILED, std::nullopt, std::nullopt));
    } else {
      CompleteHeaders(std::move(callback), headers, net::OK, std::nullopt,
                      std::nullopt);
    }
  }

 private:
  void CompleteHeaders(OnHeadersReceivedCallback callback,
                       const std::string& original,
                       int32_t result,
                       const std::optional<std::string>& modified,
                       const std::optional<GURL>& preserve_fragment) {
    if (result != net::OK) {
      std::move(callback).Run(result, modified, preserve_fragment);
      return;
    }
    const std::string& final_headers = modified ? *modified : original;
    auto parsed = base::MakeRefCounted<net::HttpResponseHeaders>(final_headers);
    if (parsed->HasHeader("set-cookie") && policy_.Run(url_)) {
      parsed->RemoveHeader("set-cookie");
      std::move(callback).Run(net::OK, parsed->raw_headers(),
                              preserve_fragment);
      return;
    }
    std::move(callback).Run(net::OK, modified, preserve_fragment);
  }

  const ResponseCookiePolicy policy_;
  // Keep a disconnected downstream remote bound. Its callbacks then fail
  // instead of silently bypassing a client Chrome required for this request.
  mojo::Remote<network::mojom::TrustedHeaderClient> target_;
  GURL url_;
  base::WeakPtrFactory<CookieHeaderClient> weak_factory_{this};
};

class CookieFactoryClient
    : public network::mojom::TrustedURLLoaderHeaderClient {
 public:
  CookieFactoryClient(
      ResponseCookiePolicy policy,
      mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient> target)
      : policy_(std::move(policy)), target_(std::move(target)) {}

  static void Create(
      ResponseCookiePolicy policy,
      mojo::PendingReceiver<network::mojom::TrustedURLLoaderHeaderClient>
          receiver,
      mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>
          target) {
    mojo::MakeSelfOwnedReceiver(std::make_unique<CookieFactoryClient>(
                                    std::move(policy), std::move(target)),
                                std::move(receiver));
  }

  void OnLoaderCreated(
      int32_t request_id,
      mojo::PendingReceiver<network::mojom::TrustedHeaderClient> receiver)
      override {
    mojo::PendingRemote<network::mojom::TrustedHeaderClient> target;
    if (target_.is_bound()) {
      target_->OnLoaderCreated(request_id,
                               target.InitWithNewPipeAndPassReceiver());
    }
    BindLoader(std::move(receiver), std::move(target));
  }

  void OnLoaderForCorsPreflightCreated(
      const network::ResourceRequest& request,
      mojo::PendingReceiver<network::mojom::TrustedHeaderClient> receiver)
      override {
    mojo::PendingRemote<network::mojom::TrustedHeaderClient> target;
    if (target_.is_bound()) {
      target_->OnLoaderForCorsPreflightCreated(
          request, target.InitWithNewPipeAndPassReceiver());
    }
    BindLoader(std::move(receiver), std::move(target));
  }

 private:
  void BindLoader(
      mojo::PendingReceiver<network::mojom::TrustedHeaderClient> receiver,
      mojo::PendingRemote<network::mojom::TrustedHeaderClient> target) {
    mojo::MakeSelfOwnedReceiver(
        std::make_unique<CookieHeaderClient>(policy_, std::move(target)),
        std::move(receiver));
  }

  const ResponseCookiePolicy policy_;
  mojo::Remote<network::mojom::TrustedURLLoaderHeaderClient> target_;
};

}  // namespace

void WrapResponseCookieFilter(
    mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>*
        header_client,
    ResponseCookiePolicy policy,
    scoped_refptr<base::SequencedTaskRunner> task_runner) {
  if (!header_client || !policy) {
    return;
  }
  mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient> replacement;
  auto receiver = replacement.InitWithNewPipeAndPassReceiver();
  task_runner->PostTask(
      FROM_HERE,
      base::BindOnce(&CookieFactoryClient::Create, std::move(policy),
                     std::move(receiver), std::move(*header_client)));
  *header_client = std::move(replacement);
}

}  // namespace nncore
