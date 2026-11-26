// A coding agent's own access to Bay (engine nn_cli_agents.h): `bay mcp serve --agent codex` asks over the bay
// command's connection (Bay.requestAgentAccess), Bay asks the person, and an allowed agent then connects with its
// own token, which Bay keeps to the spaces it was given and away from private windows. The person can take it back
// in Settings › Advanced.
import * as v from "valibot";
import type { Cdp } from "./cdp.ts";
import type { Endpoint } from "./endpoint.ts";
import { addSecret } from "./redact.ts";
import { sleep } from "./util.ts";

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** What Bay calls the agents `bay mcp install` knows. */
export const AGENT_NAMES = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", vscode: "VS Code" } as const;

export const agentName = (agent: string) => Object.entries(AGENT_NAMES).find(([id]) => id === agent)?.[1] ?? agent;

const AnswerSchema = v.variant("state", [
  v.object({ state: v.literal("granted"), token: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{40,}$/)) }),
  v.object({ state: v.literal("pending") }),
  v.object({ state: v.literal("denied") }),
]);

export class AgentAccessError extends Error {}

export type AccessOptions = {
  /** How long to wait for the person's answer. */
  waitMs?: number;
  pollMs?: number;
  /** Said once, when Bay starts asking. */
  notice?: (message: string) => void;
};

/** The agent's token once the person allows it; an AgentAccessError if they don't, or don't answer in time. */
export async function requestAgentAccess(cdp: Pick<Cdp, "send">, agent: string, options: AccessOptions = {}): Promise<string> {
  const { waitMs = 120_000, pollMs = 1500, notice = () => {} } = options;
  const name = agentName(agent);
  const deadline = Date.now() + waitMs;
  let noticed = false;

  for (;;) {
    const reply = await cdp.send("Bay.requestAgentAccess", { agent, name }).catch((error: Error) => {
      throw new AgentAccessError(/isn't allowed/.test(error.message) ? "this Bay can't give coding agents their own access; update Bay" : error.message);
    });

    const answer = v.safeParse(AnswerSchema, reply);

    if (!answer.success) throw new AgentAccessError("this Bay can't give coding agents their own access; update Bay");

    if (answer.output.state === "granted") {
      addSecret(answer.output.token);

      return answer.output.token;
    }

    if (answer.output.state === "denied") throw new AgentAccessError(`${name} wasn't allowed to use Bay`);

    if (Date.now() >= deadline) throw new AgentAccessError(`nobody answered in Bay; allow ${name} there, then try again`);

    if (!noticed) {
      noticed = true;
      notice(`waiting for you to allow ${name} in Bay`);
    }

    await sleep(pollMs);
  }
}

/** The endpoint with the agent's token in place of the bay command's. */
export function withToken(endpoint: Endpoint, token: string): Endpoint {
  const swap = (url: string) => {
    const parsed = new URL(url);

    if (!parsed.searchParams.has("token")) throw new AgentAccessError("--agent needs Bay's own control, not --ws or --port");
    parsed.searchParams.set("token", token);

    return parsed.href;
  };

  return { ...endpoint, ws: swap(endpoint.ws), active: endpoint.active && swap(endpoint.active) };
}
