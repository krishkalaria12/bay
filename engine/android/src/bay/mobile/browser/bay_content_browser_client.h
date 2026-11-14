// Copyright 2026 Bay authors. Adapted from content/shell/browser/shell_content_browser_client.h, Copyright 2012 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_CONTENT_BROWSER_CLIENT_H_
#define BAY_MOBILE_BROWSER_BAY_CONTENT_BROWSER_CLIENT_H_

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "content/public/browser/content_browser_client.h"

namespace bay {

// The browser process's policy: profiles' network setup, the user agent, child processes' resources, and the page
// questions content asks the embedder (HTTP sign-in, links to other apps), which go to the tab.
class BayContentBrowserClient : public content::ContentBrowserClient {
 public:
  BayContentBrowserClient();
  BayContentBrowserClient(const BayContentBrowserClient&) = delete;
  BayContentBrowserClient& operator=(const BayContentBrowserClient&) = delete;
  ~BayContentBrowserClient() override;

  // content::ContentBrowserClient:
  std::unique_ptr<content::BrowserMainParts> CreateBrowserMainParts(bool is_integration_test) override;
  void GetAdditionalMappedFilesForChildProcess(const base::CommandLine& command_line,
                                               int child_process_id,
                                               content::PosixFileDescriptorInfo* mappings) override;
  std::string GetApplicationLocale() override;
  std::string GetAcceptLangs(content::BrowserContext* context) override;
  std::string GetProduct() override;
  std::string GetUserAgent() override;
  blink::UserAgentMetadata GetUserAgentMetadata() override;
  void ConfigureNetworkContextParams(content::BrowserContext* context,
                                     bool in_memory,
                                     const base::FilePath& relative_partition_path,
                                     network::mojom::NetworkContextParams* network_context_params,
                                     cert_verifier::mojom::CertVerifierCreationParams*
                                         cert_verifier_creation_params) override;
  std::vector<base::FilePath> GetNetworkContextsParentDirectory() override;
  std::unique_ptr<content::LoginDelegate> CreateLoginDelegate(
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
      content::LoginDelegate::LoginAuthRequiredCallback auth_required_callback) override;
  bool HandleExternalProtocol(const GURL& url,
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
                              mojo::PendingRemote<network::mojom::URLLoaderFactory>* out_factory) override;
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_CONTENT_BROWSER_CLIENT_H_
