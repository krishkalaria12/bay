// Copyright 2026 Bay authors. Adapted from content/shell/browser/shell_content_browser_client.cc, Copyright 2012 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_content_browser_client.h"

#include <utility>

#include "base/android/locale_utils.h"
#include "base/files/file_path.h"
#include "base/memory/weak_ptr.h"
#include "base/posix/global_descriptors.h"
#include "bay/filter/nn_request_filter.h"
#include "bay/mobile/browser/bay_browser_main_parts.h"
#include "bay/mobile/browser/bay_https_upgrade_throttle.h"
#include "bay/mobile/browser/bay_tab.h"
#include "bay/mobile/common/bay_descriptors.h"
#include "components/autofill/content/browser/content_autofill_driver_factory.h"
#include "components/embedder_support/user_agent_utils.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/login_delegate.h"
#include "content/public/browser/posix_file_descriptor_info.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/auth.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "services/network/public/mojom/websocket.mojom.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"
#include "url/url_constants.h"

namespace bay {

namespace {

// HTTP sign-in for one request: the tab asks the person, and the answer goes back unless the request has gone.
class BayLoginDelegate : public content::LoginDelegate {
 public:
  BayLoginDelegate(BayTab* tab,
                   const net::AuthChallengeInfo& auth_info,
                   content::LoginDelegate::LoginAuthRequiredCallback callback)
      : tab_(tab->GetWeakPtr()), callback_(std::move(callback)) {
    request_id_ = tab->RequestHttpAuth(auth_info.challenger.host(), auth_info.realm,
                                       base::BindOnce(&BayLoginDelegate::OnAnswer, weak_factory_.GetWeakPtr()));
  }

  ~BayLoginDelegate() override {
    if (tab_) {
      tab_->CancelHttpAuth(request_id_);
    }
  }

 private:
  void OnAnswer(const std::optional<net::AuthCredentials>& credentials) {
    if (callback_) {
      std::move(callback_).Run(credentials);
    }
  }

  base::WeakPtr<BayTab> tab_;
  content::LoginDelegate::LoginAuthRequiredCallback callback_;
  int request_id_ = 0;
  base::WeakPtrFactory<BayLoginDelegate> weak_factory_{this};
};

}  // namespace

BayContentBrowserClient::BayContentBrowserClient() = default;

BayContentBrowserClient::~BayContentBrowserClient() = default;

std::unique_ptr<content::BrowserMainParts> BayContentBrowserClient::CreateBrowserMainParts(bool is_integration_test) {
  return std::make_unique<BayBrowserMainParts>();
}

void BayContentBrowserClient::GetAdditionalMappedFilesForChildProcess(const base::CommandLine& command_line,
                                                                      int child_process_id,
                                                                      content::PosixFileDescriptorInfo* mappings) {
  mappings->ShareWithRegion(kBayEnginePakDescriptor,
                            base::GlobalDescriptors::GetInstance()->Get(kBayEnginePakDescriptor),
                            base::GlobalDescriptors::GetInstance()->GetRegion(kBayEnginePakDescriptor));
}

std::string BayContentBrowserClient::GetApplicationLocale() {
  return base::android::GetDefaultLocaleString();
}

std::string BayContentBrowserClient::GetAcceptLangs(content::BrowserContext* context) {
  return base::android::GetDefaultLocaleListString();
}

// Sites see Chrome on Android (Chrome/<major>.0.0.0, reduced), "Mobile" included: BayEngine starts the browser with
// --use-mobile-user-agent. A tab in desktop mode overrides it per navigation (BayTab.java).
std::string BayContentBrowserClient::GetProduct() {
  return embedder_support::GetProductAndVersion();
}

std::string BayContentBrowserClient::GetUserAgent() {
  return embedder_support::GetUserAgent();
}

blink::UserAgentMetadata BayContentBrowserClient::GetUserAgentMetadata() {
  return embedder_support::GetUserAgentMetadata();
}

void BayContentBrowserClient::ConfigureNetworkContextParams(
    content::BrowserContext* context,
    bool in_memory,
    const base::FilePath& relative_partition_path,
    network::mojom::NetworkContextParams* network_context_params,
    cert_verifier::mojom::CertVerifierCreationParams* cert_verifier_creation_params) {
  network_context_params->user_agent = GetUserAgent();
  network_context_params->accept_language = GetAcceptLangs(context);
  network_context_params->enable_zstd = true;
  if (in_memory) {
    // A private profile: cookies, cache and everything else stay in memory.
    network_context_params->http_cache_enabled = true;
    return;
  }
  // The normal profile keeps signed-in sites across restarts, session cookies included, as the system WebView did.
  // The app's private data directory is the protection; Android keeps no OS keychain for cookies.
  const base::FilePath path = context->GetPath().Append(relative_partition_path);
  network_context_params->file_paths = network::mojom::NetworkContextFilePaths::New();
  network_context_params->file_paths->data_directory = path.Append(FILE_PATH_LITERAL("Network"));
  network_context_params->file_paths->unsandboxed_data_path = path;
  network_context_params->file_paths->cookie_database_name = base::FilePath(FILE_PATH_LITERAL("Cookies"));
  network_context_params->file_paths->http_cache_directory = path.Append(FILE_PATH_LITERAL("Cache"));
  network_context_params->enable_encrypted_cookies = false;
  network_context_params->persist_session_cookies = true;
  network_context_params->restore_old_session_cookies = true;
  network_context_params->http_cache_enabled = true;
}

std::vector<base::FilePath> BayContentBrowserClient::GetNetworkContextsParentDirectory() {
  return {BayBrowserMainParts::ProfilesDirectory()};
}

// Bay's content blocker (//bay/filter, the same as desktop's) sees navigations, subresources, responses and
// WebSockets of every page, in every profile. It filters nothing until the app sets lists (BayContentBlocker).
void BayContentBrowserClient::CreateThrottlesForNavigation(content::NavigationThrottleRegistry& registry) {
  nncore::MaybeAddRequestFilterThrottle(registry);
  BayHttpsUpgradeThrottle::MaybeAdd(registry);
}

void BayContentBrowserClient::WillCreateURLLoaderFactory(
    content::BrowserContext* browser_context,
    content::RenderFrameHost* frame,
    int render_process_id,
    URLLoaderFactoryType type,
    const url::Origin& request_initiator,
    const net::IsolationInfo& isolation_info,
    std::optional<int64_t> navigation_id,
    ukm::SourceIdObj ukm_source_id,
    network::URLLoaderFactoryBuilder& factory_builder,
    mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>* header_client,
    bool* bypass_redirect_checks,
    bool* disable_secure_dns,
    network::mojom::URLLoaderFactoryOverridePtr* factory_override,
    scoped_refptr<base::SequencedTaskRunner> navigation_response_task_runner,
    bool is_for_network_service) {
  auto cookie_policy =
      nncore::MaybeFilterURLLoaderFactory(type, request_initiator, isolation_info, factory_builder, frame);
  if (cookie_policy) {
    std::move(cookie_policy).Run(header_client);
  }
}

// Each frame's AutofillAgent reports forms to its driver, which BayTab's autofill client hands to Android.
void BayContentBrowserClient::RegisterAssociatedInterfaceBindersForRenderFrameHost(
    content::RenderFrameHost& render_frame_host,
    blink::AssociatedInterfaceRegistry& associated_registry) {
  associated_registry.AddInterface<autofill::mojom::AutofillDriver>(
      base::BindRepeating(&autofill::ContentAutofillDriverFactory::BindAutofillDriver, &render_frame_host));
}

void BayContentBrowserClient::ExposeInterfacesToRenderer(service_manager::BinderRegistry* registry,
                                                         blink::AssociatedInterfaceRegistry* associated_registry,
                                                         content::RenderProcessHost* render_process_host) {
  // The blocker's scriptlets, which each document asks for as it starts (BayContentRendererClient).
  nncore::ExposeScriptlets(registry);
}

bool BayContentBrowserClient::WillInterceptWebSocket(content::RenderFrameHost* frame) {
  return nncore::HasRequestFilter();
}

void BayContentBrowserClient::CreateWebSocket(content::RenderFrameHost* frame,
                                              WebSocketFactory factory,
                                              const GURL& url,
                                              const net::SiteForCookies& site_for_cookies,
                                              const std::optional<std::string>& user_agent,
                                              mojo::PendingRemote<network::mojom::WebSocketHandshakeClient> client,
                                              WebSocketOptions options) {
  if (nncore::ShouldBlockWebSocket(frame, url, site_for_cookies)) {
    mojo::Remote<network::mojom::WebSocketHandshakeClient>(std::move(client))
        ->OnFailure("Blocked by Bay's content blocker", net::ERR_BLOCKED_BY_CLIENT, 0);
    return;
  }
  std::vector<network::mojom::HttpHeaderPtr> headers;
  if (user_agent) {
    headers.push_back(network::mojom::HttpHeader::New(net::HttpRequestHeaders::kUserAgent, *user_agent));
  }
  std::move(factory).Run(url, std::move(headers), std::move(client), mojo::NullRemote(),
                         std::move(options.header_client));
}

std::unique_ptr<content::LoginDelegate> BayContentBrowserClient::CreateLoginDelegate(
    const net::AuthChallengeInfo& auth_info,
    content::WebContents* web_contents,
    content::BrowserContext* browser_context,
    const content::GlobalRequestID& request_id,
    bool is_request_for_primary_main_frame_navigation,
    bool is_request_for_navigation,
    const GURL& url,
    scoped_refptr<net::HttpResponseHeaders> response_headers,
    bool first_auth_attempt,
    content::GuestPageHolder* guest_page_holder,
    content::LoginDelegate::LoginAuthRequiredCallback auth_required_callback) {
  BayTab* tab = BayTab::FromWebContents(web_contents);
  // Only the page itself asks: a subresource or proxy challenge with no tab is cancelled.
  if (!tab || auth_info.is_proxy) {
    return nullptr;
  }
  return std::make_unique<BayLoginDelegate>(tab, auth_info, std::move(auth_required_callback));
}

bool BayContentBrowserClient::HandleExternalProtocol(
    const GURL& url,
    base::RepeatingCallback<content::WebContents*()> web_contents_getter,
    content::FrameTreeNodeId frame_tree_node_id,
    content::NavigationUIData* navigation_data,
    bool is_primary_main_frame,
    bool is_in_fenced_frame_tree,
    network::mojom::WebSandboxFlags sandbox_flags,
    ui::PageTransition page_transition,
    bool has_user_gesture,
    const std::optional<url::Origin>& initiating_origin,
    content::RenderFrameHost* initiator_document,
    const net::IsolationInfo& isolation_info,
    mojo::PendingRemote<network::mojom::URLLoaderFactory>* out_factory) {
  // A sandboxed or fenced frame can't send the person to another app.
  if (is_in_fenced_frame_tree) {
    return true;
  }
  BayTab* tab = BayTab::FromWebContents(web_contents_getter.Run());
  if (tab) {
    tab->OpenExternalUrl(url, has_user_gesture);
  }
  // Handled: the page stays where it was.
  return true;
}

}  // namespace bay
