import { answerCliAgent, cliAgents, onCliAgentsChanged, revokeCliAgent, type CliAgent, type CliAgents } from "@bay/chromium";
import { confirm } from "@bay/desktop";
import { create } from "zustand";
import { engineProfile, isIncognitoSpace } from "../../store/model";
import { browserRead } from "../../store/read";

// Coding agents asking for their own access (`bay mcp serve --agent …`, engine nn_cli_agents.h): Bay asks the person
// once, in the window they're using, and an allowed agent reaches only that window's space until Settings › Advanced
// gives it more. Its tools never reach private windows.

export const useCliAgents = create<CliAgents>(() => ({ agents: [], requests: [], loaded: false }));

/** An engine profile id ("" the default) as the directory name the engine keeps a grant under. */
export const profileDir = (profile: string) => profile || "Default";

/** The spaces whose pages an agent reaches: their ids, or null for every one. */
export function agentSpaces(agent: CliAgent, spaceIds: readonly string[]): string[] | null {
  if (!agent.profiles) return null;
  const dirs = new Set(agent.profiles);

  return spaceIds.filter((id) => !isIncognitoSpace(id) && dirs.has(profileDir(engineProfile(id))));
}

/** The engine profiles for these spaces, each once; null (every space) stays null. */
export const spaceProfiles = (spaceIds: readonly string[] | null): string[] | null =>
  spaceIds && [...new Set(spaceIds.filter((id) => !isIncognitoSpace(id)).map(engineProfile))];

export const setAgentSpaces = (agent: string, spaceIds: readonly string[] | null) => answerCliAgent(agent, true, spaceProfiles(spaceIds));

export const removeAgent = (agent: string) => revokeCliAgent(agent);

/** The window the person is using, and its space: where Bay asks, and what an agent gets first. */
function askingWindow(): { windowId: string; spaceId: string; spaceName: string } | null {
  const s = browserRead.getState();
  const windowId = s.ui.focusOrder.find((id) => s.windows[id] && !s.windows[id]!.incognito);
  const window = windowId ? s.windows[windowId] : undefined;

  if (!windowId || !window) return null;

  return { windowId, spaceId: window.spaceId, spaceName: s.spaces[window.spaceId]?.name ?? "this space" };
}

export type Asker = typeof confirm;

/** Asks about each agent still waiting, once a run; an agent asked about with no window open is asked later. */
export function askAboutRequests(agents: CliAgents, asked: Set<string>, ask: Asker = confirm): Promise<void>[] {
  return agents.requests.flatMap((request) => {
    if (asked.has(request.agent)) return [];
    const where = askingWindow();

    if (!where) return [];
    asked.add(request.agent);

    return [
      (async () => {
        const { confirmed } = await ask({
          title: `Allow ${request.name} to use Bay?`,
          message: `${request.name} asked through the bay command. It could open, read and use the web pages in ${where.spaceName}, but never private windows. Settings › Advanced can give it more spaces, or take this back.`,
          confirmTitle: `Allow in ${where.spaceName}`,
          cancelTitle: "Don't Allow",
          windowId: where.windowId,
        });

        await answerCliAgent(request.agent, confirmed, confirmed ? spaceProfiles([where.spaceId]) : undefined);
      })().catch(() => {
        asked.delete(request.agent);
      }),
    ];
  });
}

/** Follows the engine's agents for the app's life, asking about new requests as they come. */
export function startAgentApprovals(): () => void {
  const asked = new Set<string>();

  const apply = (agents: CliAgents) => {
    useCliAgents.setState(agents);

    // An agent no longer waiting can ask again later.
    for (const agent of asked) if (!agents.requests.some((r) => r.agent === agent)) asked.delete(agent);
    void askAboutRequests(agents, asked);
  };

  const subscription = onCliAgentsChanged(apply);
  void cliAgents()
    .then(apply)
    .catch(() => {});

  return () => subscription.remove();
}
