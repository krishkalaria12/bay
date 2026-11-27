import * as v from "valibot";
import { engineCall, onEngineEvent } from "./engineInfo";

// Coding agents' own access to the bay command's control (engine nn_cli_agents.h): which agents may use Bay and in
// which profiles (directory names; null is every one), and the agents waiting for the person's answer.

const AgentsSchema = v.object({
  agents: v.array(v.object({ id: v.string(), name: v.string(), created: v.number(), profiles: v.nullable(v.array(v.string())) })),
  requests: v.array(v.object({ agent: v.string(), name: v.string(), at: v.number() })),
  loaded: v.boolean(),
});

export type CliAgents = v.InferOutput<typeof AgentsSchema>;

export type CliAgent = CliAgents["agents"][number];

export const cliAgents = async (): Promise<CliAgents> => v.parse(AgentsSchema, await engineCall("nn_cli_agents", ""));

/** Allows an agent (in these engine profiles, "" the default; null every one) or doesn't. */
export const answerCliAgent = (agent: string, allow: boolean, profiles?: string[] | null) =>
  engineCall("nn_cli_agent_answer", "", profiles === undefined ? { agent, allow } : { agent, allow, profiles });

export const revokeCliAgent = (agent: string) => engineCall("nn_cli_agent_revoke", "", { agent });

export const onCliAgentsChanged = (listener: (agents: CliAgents) => void) =>
  onEngineEvent((_topic, payload) => {
    const parsed = v.safeParse(AgentsSchema, payload);

    if (parsed.success) listener(parsed.output);
  }, "cliAgents");
