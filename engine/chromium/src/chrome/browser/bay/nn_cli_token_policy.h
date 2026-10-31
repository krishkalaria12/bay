// Copyright 2026 Bay. Apache-2.0.

#ifndef CHROME_BROWSER_BAY_NN_CLI_TOKEN_POLICY_H_
#define CHROME_BROWSER_BAY_NN_CLI_TOKEN_POLICY_H_

#include <memory>

#include "bay/core/nn_content_hooks.h"  // nogncheck

namespace content {
class DevToolsAgentHost;
class DevToolsAgentHostClient;
class RenderFrameHost;
}

namespace bay {

std::unique_ptr<BayDevToolsTokenClient> CreateTokenClient(
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host);

bool TokenClientMayAttach(content::DevToolsAgentHostClient* root_client,
                          content::DevToolsAgentHost* host);

bool TokenClientMayInput(content::DevToolsAgentHostClient* root_client,
                         content::RenderFrameHost* frame);

}

#endif
