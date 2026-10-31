#ifndef BAY_CORE_NN_CONTENT_HOOKS_H_
#define BAY_CORE_NN_CONTENT_HOOKS_H_

#include <cstddef>
#include <memory>
#include <string>
#include <string_view>

class GURL;
namespace content {
class DevToolsAgentHost;
class DevToolsAgentHostClient;
class DevToolsSocketFactory;
class RenderFrameHost;
}

extern bool (*g_bay_devtools_token_factory)(
    const content::DevToolsSocketFactory* factory);

extern bool (*g_bay_devtools_token_accepts)(
    const content::DevToolsSocketFactory* factory,
    std::string_view token);

extern void (*g_bay_devtools_token_server)(
    const content::DevToolsSocketFactory* factory,
    std::string_view browser_path,
    int port,
    size_t connections);

extern bool (*g_bay_devtools_active_target)(
    const content::DevToolsSocketFactory* factory,
    std::string_view token,
    std::string* target_id);

class BayDevToolsTokenClient {
 public:
  virtual ~BayDevToolsTokenClient() = default;
  virtual bool FilterCommand(std::string& message, std::string* reply) = 0;
  virtual bool FilterEvent(std::string& message) = 0;
  virtual bool ShouldClose() const = 0;
  virtual bool MayAttachToURL(const GURL& url, bool is_webui) = 0;
  virtual bool MayAttachToRenderFrameHost(
      content::RenderFrameHost* render_frame_host) = 0;
};

extern std::unique_ptr<BayDevToolsTokenClient> (*g_bay_devtools_token_client)(
    const content::DevToolsSocketFactory* factory,
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host);

extern bool (*g_bay_devtools_may_attach)(
    content::DevToolsAgentHostClient* root_client,
    content::DevToolsAgentHost* host);

extern bool (*g_bay_devtools_may_input)(
    content::DevToolsAgentHostClient* root_client,
    content::RenderFrameHost* frame);

#endif
