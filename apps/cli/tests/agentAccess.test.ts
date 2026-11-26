import { describe, expect, test } from "bun:test";
import { AgentAccessError, agentName, requestAgentAccess, withToken } from "../src/agentAccess.ts";
import type { CdpObject } from "../src/cdp.ts";

const TOKEN = "a".repeat(43);

function bay(answers: CdpObject[], failure?: string) {
  const asked: CdpObject[] = [];

  return {
    asked,
    cdp: {
      send: async (method: string, params: CdpObject = {}): Promise<CdpObject> => {
        if (failure) throw new Error(failure);
        expect(method).toBe("Bay.requestAgentAccess");
        asked.push(params);

        return answers.shift() ?? { state: "pending" };
      },
    },
  };
}

describe("requestAgentAccess", () => {
  test("waits while Bay asks, then takes the agent's token", async () => {
    const notices: string[] = [];
    const { cdp, asked } = bay([{ state: "pending" }, { state: "pending" }, { state: "granted", token: TOKEN }]);

    expect(await requestAgentAccess(cdp, "claude-code", { pollMs: 1, notice: (m) => notices.push(m) })).toBe(TOKEN);
    expect(asked).toEqual([
      { agent: "claude-code", name: "Claude Code" },
      { agent: "claude-code", name: "Claude Code" },
      { agent: "claude-code", name: "Claude Code" },
    ]);
    expect(notices).toEqual(["waiting for you to allow Claude Code in Bay"]);
  });

  test("a refusal, no answer in time, an odd answer and an old Bay are errors", async () => {
    await expect(requestAgentAccess(bay([{ state: "denied" }]).cdp, "codex", { pollMs: 1 })).rejects.toThrow("Codex wasn't allowed");
    await expect(requestAgentAccess(bay([]).cdp, "my-agent", { pollMs: 1, waitMs: 5 })).rejects.toThrow("allow my-agent there");
    await expect(requestAgentAccess(bay([{ state: "granted", token: "short" }]).cdp, "codex")).rejects.toBeInstanceOf(AgentAccessError);
    await expect(requestAgentAccess(bay([], "bay: Bay.requestAgentAccess isn't allowed for the bay command").cdp, "codex")).rejects.toThrow("update Bay");
  });
});

test("the agent's token takes the bay command's place, and only Bay's own control has one", () => {
  const endpoint = { ws: "ws://127.0.0.1:9/devtools/browser/x?token=root", source: "f", explicit: false, active: "http://127.0.0.1:9/bay/active?token=root" };

  expect(withToken(endpoint, TOKEN)).toEqual({
    ...endpoint,
    ws: `ws://127.0.0.1:9/devtools/browser/x?token=${TOKEN}`,
    active: `http://127.0.0.1:9/bay/active?token=${TOKEN}`,
  });
  expect(() => withToken({ ...endpoint, ws: "ws://127.0.0.1:9/devtools/browser/x", active: null }, TOKEN)).toThrow("--agent needs");
  expect(agentName("vscode")).toBe("VS Code");
  expect(agentName("other")).toBe("other");
});
