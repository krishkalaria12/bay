// Copyright 2026 Bay. Apache-2.0.
//
// Coding agents' own tokens for the bay command's control server. An agent
// (`bay mcp serve --agent codex`) asks over the bay command's connection
// (Bay.requestAgentAccess); the app asks the person, who allows it in every
// space or only some, or doesn't. An allowed agent connects with its own token,
// and the token policy (nn_cli_token_policy) keeps that connection to the
// spaces it was given. The person can take an agent's access back at any time:
// its connections close at their next message.
//
// The grants live in <user data>/BayAgents.json, written owner-only as
// BayControl.json is; tokens are as secret as the bay command's own. This
// keeps an agent's MCP tools in its spaces. It isn't a sandbox: an agent
// that can run programs as the person can read the bay command's token too.
//
//   nn_cli_agents {} -> {agents: [{id, name, profiles: [dir…] | null,
//                        created}], requests: [{agent, name, at}]}
//   nn_cli_agent_answer {agent, allow, profiles?: [id…] | null} -> {ok}
//       profiles are the app's engine profile ids ("" is the default);
//       null or absent allows every space.
//   nn_cli_agent_revoke {agent} -> {ok}
//
// Events: "cliAgents", the nn_cli_agents answer, whenever it changes.

#ifndef CHROME_BROWSER_BAY_NN_CLI_AGENTS_H_
#define CHROME_BROWSER_BAY_NN_CLI_AGENTS_H_

#include <optional>
#include <string>
#include <string_view>

#include "base/values.h"
#include "chrome/browser/bay/nn_engine.h"

namespace base {
class FilePath;
class Lock;
}  // namespace base

namespace content {
class BrowserContext;
}

namespace bay {

// Writes |contents| to |path| so only this user can read it, by way of a temp
// file beside it; an error names the file as |what| ("the terminal control
// file"). With |lock|, |still_wanted(generation)| is checked under it just
// before the file replaces |path|, and can call the write off.
std::string WriteOwnerOnlyFile(const base::FilePath& path,
                               const std::string& contents,
                               std::string_view what,
                               base::Lock* lock = nullptr,
                               bool (*still_wanted)(uint64_t) = nullptr,
                               uint64_t generation = 0);

namespace cli_agents {

// Loads the grants (once, off the UI thread); until then no agent token works.
void Load();

// The agent whose token this is, if it's one.
std::optional<std::string> AgentForToken(std::string_view token);

// Whether |agent| still has access, and may reach pages of |context|.
bool HasAccess(const std::string& agent);
bool Allows(const std::string& agent, content::BrowserContext* context);

// Bay.requestAgentAccess's result: {state: "granted", token} for an allowed
// agent, else {state: "pending"} (the app asks) or {state: "denied"}; an
// error string for bad arguments.
base::DictValue Request(const base::DictValue& params, std::string* error);

}  // namespace cli_agents
}  // namespace bay

NN_ENGINE_CALL(nn_cli_agents);
NN_ENGINE_CALL(nn_cli_agent_answer);
NN_ENGINE_CALL(nn_cli_agent_revoke);

#endif  // CHROME_BROWSER_BAY_NN_CLI_AGENTS_H_
