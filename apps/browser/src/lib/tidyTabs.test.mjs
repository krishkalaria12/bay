import assert from "node:assert/strict";
import { test } from "node:test";
import { tidyTabsAnswers } from "@bay/desktop";
const { useBrowser } = await import("../store/browserStore.ts");
const { useToasts } = await import("../components/ui/toasts.ts");
const { runTidyTabs, useTidyTabs } = await import("./tidyTabs.ts");
const { tidyTabCounts } = await import("../store/tabTidying.ts");
const { offersTidy } = await import("@bay/core");

const S = () => useBrowser.getState();
const groupOfTab = (id) => Object.values(S().groups).find((g) => g.tabIds.includes(id));
const toast = (w) => useToasts.getState().toasts[w];

function setup(urls, { status = "available", answer = async () => null } = {}) {
  S().hydrate({});
  useTidyTabs.setState({ running: {}, tidied: {} });
  tidyTabsAnswers.status = status;
  tidyTabsAnswers.answer = answer;
  tidyTabsAnswers.prompts.length = 0;
  const w = S().createWindow({ url: urls[0] });
  const ids = [S().windows[w].activeTabIds[S().windows[w].spaceId], ...urls.slice(1).map((url) => S().newTab(w, { url, background: true }))];
  return { w, ids };
}

// The prompt's ids for the tabs whose line matches: the list's order isn't the order they were opened in.
const idsMatching = (prompt, pattern) =>
  prompt
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => Number.parseInt(line, 10));
const planets = async (prompt) => [{ name: "Planets", tabs: idsMatching(prompt, /nasa|wikipedia/) }];

const SITES = ["https://nasa.gov/nasa", "https://wikipedia.org/saturn", "https://nasa.gov/jupiter", "https://booking.com/lisbon", "https://example.com/x"];

test("the model's groups sort tabs by topic across sites", async () => {
  const { w, ids } = setup(SITES, { answer: planets });
  const run = runTidyTabs(w);
  assert.equal(useTidyTabs.getState().running[S().windows[w].spaceId], true);
  await run;
  assert.equal(useTidyTabs.getState().running[S().windows[w].spaceId], undefined);
  assert.equal(tidyTabsAnswers.prompts.length, 1);
  assert.match(tidyTabsAnswers.prompts[0], /\(nasa\.gov\)/);
  assert.equal(groupOfTab(ids[0]).name, "Planets");
  assert.deepEqual([...groupOfTab(ids[0]).tabIds].sort(), [ids[0], ids[1], ids[2]].sort());
  assert.equal(groupOfTab(ids[3]), undefined);
  assert.equal(toast(w).title, "Tabs Tidied");
});

const offered = (w) => {
  const { tabCount, loose } = tidyTabCounts(S(), w);
  return offersTidy(tabCount, loose, useTidyTabs.getState().tidied[S().windows[w].spaceId] ?? null);
};

test("after a run Tidy waits for a new tab, and undoing it offers Tidy again", async () => {
  const { w, ids } = setup([...SITES, "https://example.org/y"], { answer: planets });
  assert.equal(offered(w), true);
  await runTidyTabs(w);
  assert.equal(offered(w), false);
  toast(w).action.run();
  assert.equal(groupOfTab(ids[0]), undefined);
  assert.equal(offered(w), true);
  await runTidyTabs(w);
  S().newTab(w, { url: "https://example.org/new", background: true });
  assert.equal(offered(w), true);
});

test("without the model, or when it can't answer, tabs group by site", async () => {
  for (const options of [{ status: "off" }, { answer: async () => null }, { answer: async () => [{ name: "Alone", tabs: [0] }] }]) {
    const { w, ids } = setup(SITES, options);
    await runTidyTabs(w);
    assert.deepEqual([...groupOfTab(ids[0]).tabIds].sort(), [ids[0], ids[2]].sort(), JSON.stringify(options));
    if (options.status === "off") assert.equal(tidyTabsAnswers.prompts.length, 0);
  }
});

test("a model that throws doesn't leave the sidebar waving", async () => {
  const { w, ids } = setup(SITES, { answer: () => Promise.reject(new Error("busy")) });
  await runTidyTabs(w);
  assert.deepEqual(useTidyTabs.getState().running, {});
  assert.ok(groupOfTab(ids[0]));
});

test("a private window's tabs never reach the model", async () => {
  const { w: normal } = setup(SITES, { answer: async () => [{ name: "Planets", tabs: [0, 1] }] });
  const w = S().createWindow({ url: SITES[0], incognito: true });
  const space = S().windows[w].spaceId;
  S().newTab(w, { url: SITES[2], background: true });
  await runTidyTabs(w);
  assert.equal(tidyTabsAnswers.prompts.length, 0);
  assert.ok(S().windows[normal]);
  assert.ok(Object.values(S().groups).some((g) => g.spaceId === space));
});

test("tabs joining a named group need no group of their own", async () => {
  const { w, ids } = setup(SITES, { answer: async (prompt) => [{ name: "planets", tabs: idsMatching(prompt, /nasa/) }] });
  const groupId = S().groupTabs([ids[1], ids[2]], { pinned: false, name: "Planets" });
  await runTidyTabs(w);
  assert.match(tidyTabsAnswers.prompts[0], /"Planets"/);
  assert.equal(groupOfTab(ids[0]).id, groupId);
});

test("a window closed while the model thinks is left alone", async () => {
  const { w, ids } = setup(SITES, {
    answer: async () => {
      S().closeWindow(w);
      return [{ name: "Planets", tabs: [0, 1] }];
    },
  });
  await runTidyTabs(w);
  assert.equal(groupOfTab(ids[0]), undefined);
});

test("a second press while it runs doesn't ask twice", async () => {
  const { w } = setup(SITES, { answer: async () => [] });
  await Promise.all([runTidyTabs(w), runTidyTabs(w)]);
  assert.equal(tidyTabsAnswers.prompts.length, 1);
});

test("nothing to group says so", async () => {
  const { w } = setup(["https://a.com", "https://b.org"].slice(0, 1));
  await runTidyTabs(w);
  assert.equal(toast(w).title, "Nothing to Tidy");
});
