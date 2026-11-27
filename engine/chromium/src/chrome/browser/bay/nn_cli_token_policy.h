// Copyright 2026 Bay. Apache-2.0.

#ifndef CHROME_BROWSER_BAY_NN_CLI_TOKEN_POLICY_H_
#define CHROME_BROWSER_BAY_NN_CLI_TOKEN_POLICY_H_

#include <memory>
#include <string>

#include "bay/core/nn_content_hooks.h"  // nogncheck

namespace content {
class DevToolsAgentHost;
class DevToolsAgentHostClient;
class RenderFrameHost;
}

namespace bay {

// |agent|: the coding agent the connection's token is for (nn_cli_agents.h),
// kept to the spaces it was given; empty for the bay command's own token.
std::unique_ptr<BayDevToolsTokenClient> CreateTokenClient(
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host,
    const std::string& agent);

bool TokenClientMayAttach(content::DevToolsAgentHostClient* root_client,
                          content::DevToolsAgentHost* host);

bool TokenClientMayInput(content::DevToolsAgentHostClient* root_client,
                         content::RenderFrameHost* frame);

}

#endif
