import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../../store/browserStore.ts");
const { engineProfile } = await import("../../store/model.ts");
const { agentSpaces, askAboutRequests, profileDir, spaceProfiles } = await import("./agentApprovals.ts");

const S = () => useBrowser.getState();

test("an agent's spaces, from the profile directories its grant names", () => {
  const spaces = ["default", "work", "incognito:1"];
  const workDir = profileDir(engineProfile("work"));

  assert.equal(agentSpaces({ id: "a", name: "A", created: 0, profiles: null }, spaces), null);
  assert.deepEqual(agentSpaces({ id: "a", name: "A", created: 0, profiles: [workDir] }, spaces), ["work"]);
  assert.deepEqual(agentSpaces({ id: "a", name: "A", created: 0, profiles: [] }, spaces), []);
  assert.deepEqual(spaceProfiles(["work", "work", "incognito:1"]), [engineProfile("work")]);
  assert.equal(spaceProfiles(null), null);
  assert.equal(profileDir(""), "Default");
});

test("each waiting agent is asked about once, in the window in use, for that window's space", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.test" });
  const asks = [];
  const ask = async (options) => (asks.push(options), { confirmed: true, suppressed: false });
  const asked = new Set();
  const agents = { agents: [], requests: [{ agent: "codex", name: "Codex", at: 1 }], loaded: true };

  await Promise.all(askAboutRequests(agents, asked, ask));
  await Promise.all(askAboutRequests(agents, asked, ask));

  assert.equal(asks.length, 1);
  assert.equal(asks[0].windowId, w);
  assert.match(asks[0].confirmTitle, /^Allow in /);
  assert.match(asks[0].message, /never private windows/);
});
