// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_cli_token_policy.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/values.h"
#include "bay/core/nn_content_hooks.h"  // nogncheck
#include "chrome/browser/bay/nn_cli_agents.h"
#include "chrome/browser/bay/nn_cli_token_policy_internal.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/render_frame_host.h"
#include "url/gurl.h"

namespace bay {
namespace cli_token_policy_internal {

std::string ErrorReply(int id,
                       const std::string& session,
                       int code,
                       const std::string& message) {
  base::DictValue error;
  error.Set("code", code);
  error.Set("message", message);
  base::DictValue reply;
  reply.Set("id", id);
  if (!session.empty()) {
    reply.Set("sessionId", session);
  }
  reply.Set("error", std::move(error));
  return base::WriteJson(reply).value_or("{}");
}

std::map<content::DevToolsAgentHostClient*, TokenClient*>& Registry() {
  static base::NoDestructor<
      std::map<content::DevToolsAgentHostClient*, TokenClient*>>
      registry;
  return *registry;
}

TokenClient::TokenClient(content::DevToolsAgentHostClient* client,
                         content::DevToolsAgentHost* host,
                         std::string agent)
    : client_(client), agent_(std::move(agent)), root_host_(host) {
  Registry()[client_] = this;
}

TokenClient::~TokenClient() {
  Registry().erase(client_);
}

bool TokenClient::FilterCommand(std::string& message, std::string* reply) {
  // Only the command about to run may steer a new tab (Target.createTarget).
  g_bay_devtools_target_context = nullptr;
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    *reply = ErrorReply(0, std::string(), kParseError,
                        "bay: a command must be a JSON object");
    return false;
  }
  base::DictValue& command = parsed->GetDict();
  const std::string* session_id = command.FindString("sessionId");
  const std::string session = session_id ? *session_id : std::string();
  std::optional<int> id = command.FindInt("id");
  const std::string* method = command.FindString("method");
  if (!id || !method || (command.Find("sessionId") && !session_id)) {
    *reply = ErrorReply(id.value_or(0), session, kInvalidRequest,
                        "bay: a command needs an id and a method");
    return false;
  }
  for (auto [key, value] : command) {
    if (key != "id" && key != "method" && key != "params" &&
        key != "sessionId") {
      *reply = ErrorReply(*id, session, kInvalidRequest,
                          base::StrCat({"bay: a command can't carry ", key}));
      return false;
    }
  }
  if (session_id && !targets_.contains(session)) {
    *reply = ErrorReply(*id, std::string(), kInvalidRequest,
                        "bay: no attached session has that sessionId");
    return false;
  }
  if (*method == "Bay.requestAgentAccess") {
    static const base::NoDestructor<base::DictValue> none;
    const base::DictValue* params = command.FindDict("params");
    *reply = AgentAccessReply(*id, session, params ? *params : *none);
    return false;
  }
  if (!AllowedMethods().contains(*method)) {
    *reply = ErrorReply(*id, session, kMethodNotAllowed,
                        base::StrCat({"bay: ", *method,
                                      " isn't allowed for the bay command"}));
    return false;
  }
  if (command.Find("params") && !command.FindDict("params")) {
    *reply = ErrorReply(*id, session, kInvalidRequest,
                        "bay: params must be an object");
    return false;
  }
  base::DictValue& params = *command.EnsureDict("params");
  std::string refusal = Refusal(*method, session, params);
  if (!refusal.empty()) {
    *reply = ErrorReply(*id, session, kRefused,
                        base::StrCat({"bay: ", *method, " ", refusal,
                                      " isn't allowed for the bay command"}));
    return false;
  }
  const std::pair<std::string, int> key(session, *id);
  if (outstanding_.contains(key)) {
    *reply = ErrorReply(*id, session, kInvalidRequest,
                        "bay: a command with that id is still waiting for "
                        "its reply");
    return false;
  }
  if (outstanding_.size() >= kMaxPending) {
    *reply = ErrorReply(*id, session, kRefused,
                        "bay: too many commands are waiting for replies; "
                        "closing the connection");
    wedged_ = true;
    return false;
  }
  outstanding_[key] = NeedsResponse(*method, params) ? *method : std::string();
  message = base::WriteJson(command).value_or(std::string());
  return !message.empty();
}

bool TokenClient::ShouldClose() const {
  // A coding agent whose access was taken back goes at its next message.
  return wedged_ || (!agent_.empty() && !cli_agents::HasAccess(agent_));
}

bool TokenClient::InScope(content::BrowserContext* context) const {
  return agent_.empty() || cli_agents::Allows(agent_, context);
}

bool TokenClient::ScopedHost(content::DevToolsAgentHost* host) const {
  return host && IsWebHost(host) &&
         (host->GetType() == content::DevToolsAgentHost::kTypeBrowser ||
          InScope(host->GetBrowserContext()));
}

content::BrowserContext* TokenClient::AgentTargetContext() const {
  ProfileManager* profiles = g_browser_process->profile_manager();
  Profile* last = profiles ? ProfileManager::GetLastUsedProfileIfLoaded()
                           : nullptr;
  if (last && InScope(last)) {
    return last;
  }
  if (!profiles) {
    return nullptr;
  }
  for (Profile* profile : profiles->GetLoadedProfiles()) {
    if (!profile->IsOffTheRecord() && InScope(profile)) {
      return profile;
    }
  }
  return nullptr;
}

bool TokenClient::ScopedTarget(const std::string* target_id) const {
  return target_id &&
         ScopedHost(content::DevToolsAgentHost::GetForId(*target_id).get());
}

std::string TokenClient::AgentAccessReply(int id,
                                          const std::string& session,
                                          const base::DictValue& params) {
  if (!session.empty() || !agent_.empty()) {
    return ErrorReply(id, session, kRefused,
                      "bay: only the bay command's own connection can ask "
                      "for a coding agent's access");
  }
  std::string error;
  base::DictValue result = cli_agents::Request(params, &error);
  if (!error.empty()) {
    return ErrorReply(id, session, kInvalidRequest,
                      base::StrCat({"bay: ", error}));
  }
  base::DictValue answer;
  answer.Set("id", id);
  answer.Set("result", std::move(result));
  return base::WriteJson(answer).value_or("{}");
}

bool TokenClient::MayAttachToURL(const GURL& url, bool is_webui) {
  return !is_webui && IsWebUrl(url);
}

bool TokenClient::MayAttachToRenderFrameHost(content::RenderFrameHost* frame) {
  return IsWebFrame(frame) && InScope(frame->GetBrowserContext());
}

std::string TokenClient::Refusal(const std::string& method,
                                 const std::string& session,
                                 base::DictValue& params) {
  for (const char* key : {"contextId", "executionContextId"}) {
    if (const base::Value* value = params.Find(key)) {
      if (!value->is_int() || !ContextAllowed(session, value->GetInt())) {
        return "in that execution context";
      }
    }
  }
  if (const base::Value* value = params.Find("uniqueContextId")) {
    if (!value->is_string() ||
        !sessions_[session].unique_ids.contains(value->GetString())) {
      return "in that execution context";
    }
  }
  if (method != "Runtime.releaseObject" &&
      !ObjectIdsAllowed(session, base::Value(params.Clone()))) {
    return "on that object";
  }
  if (method == "Target.attachToTarget") {
    if (params.FindBool("flatten") != true) {
      return "without flatten";
    }
    if (!ScopedTarget(params.FindString("targetId"))) {
      return "to that target";
    }
  } else if (method == "Target.setAutoAttach") {
    if (params.FindBool("autoAttach") != false &&
        params.FindBool("flatten") != true) {
      return "without flatten";
    }
  } else if (method == "Target.createTarget") {
    const std::string* url = params.FindString("url");
    if (!url || !IsWebDestination(*url)) {
      return "to that URL";
    }
    if (params.Find("browserContextId")) {
      return "in another browser context";
    }
    // A coding agent kept to some spaces gets its tab in one of them, whichever
    // window is in front.
    if (!agent_.empty()) {
      content::BrowserContext* context = AgentTargetContext();
      if (!context) {
        return "while none of the spaces it may use is open";
      }
      g_bay_devtools_target_context = context;
    }
  } else if (method == "Target.activateTarget" ||
             method == "Target.closeTarget") {
    if (!ScopedTarget(params.FindString("targetId"))) {
      return "on that target";
    }
  } else if (method == "Target.getTargetInfo") {
    if (params.Find("targetId") &&
        !ScopedTarget(params.FindString("targetId"))) {
      return "on that target";
    }
  } else if (method == "Page.navigate") {
    const std::string* url = params.FindString("url");
    if (!url || url->empty() || !IsWebDestination(*url)) {
      return "to that URL";
    }
  } else if (method == "Page.createIsolatedWorld") {
    params.Set("grantUniveralAccess", false);
  } else if (method == "Page.addScriptToEvaluateOnNewDocument") {
    const base::Value* world = params.Find("worldName");
    if (world && !(world->is_string() && world->GetString().empty())) {
      return "in a named world";
    }
  } else if (method == "Page.printToPDF") {
    const std::string* mode = params.FindString("transferMode");
    if (params.Find("transferMode") && (!mode || *mode != "ReturnAsBase64")) {
      return "as a stream";
    }
  } else if (method == "Runtime.evaluate") {
    if (params.FindBool("includeCommandLineAPI").value_or(false)) {
      return "with the command line API";
    }
  } else if (method == "Input.dispatchKeyEvent") {
    if (!EditingCommandsAllowed(params.Find("commands"))) {
      return "with those editing commands";
    }
    params.Remove("nativeVirtualKeyCode");
    params.Remove("isSystemKey");
  }
  return std::string();
}

}

std::unique_ptr<BayDevToolsTokenClient> CreateTokenClient(
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host,
    const std::string& agent) {
  return std::make_unique<cli_token_policy_internal::TokenClient>(client, host,
                                                                  agent);
}

bool TokenClientMayAttach(content::DevToolsAgentHostClient* root_client,
                          content::DevToolsAgentHost* host) {
  auto& registry = cli_token_policy_internal::Registry();
  auto it = registry.find(root_client);
  if (it == registry.end()) {
    return true;
  }
  return it->second->ScopedHost(host) ||
         (cli_token_policy_internal::IsPendingWebFrameHost(host) &&
          it->second->InScope(host->GetBrowserContext()));
}

bool TokenClientMayInput(content::DevToolsAgentHostClient* root_client,
                         content::RenderFrameHost* frame) {
  auto& registry = cli_token_policy_internal::Registry();
  auto it = registry.find(root_client);
  return it == registry.end() ||
         (cli_token_policy_internal::IsWebFrame(frame) &&
          it->second->InScope(frame->GetBrowserContext()));
}

}
