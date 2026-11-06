import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "./browserStore.ts";
import { useEngineView } from "./engineView.ts";
import { engineMark } from "./engines.ts";

const S = () => useBrowser.getState();

test("engine badge subscribers skip transient updates and follow all engine inputs", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://example.com" });
  const id = S().windows[w].activeTabIds.default;
  let calls = 0;
  const stop = useEngineView.subscribe(() => calls++);

  try {
    const before = useEngineView.getState();

    for (let i = 0; i < 60; i++) S().updateLive(id, { progress: i / 100 });
    S().setSelection(w, [id]);
    S().toggleSidebar(w);
    assert.equal(calls, 0);
    assert.strictEqual(useEngineView.getState(), before);
    S().updateTab(id, { engine: "webkit" });
    assert.equal(calls, 1);
    assert.equal(engineMark(useEngineView.getState(), id), "webkit");
    S().hydrate({});
    assert.strictEqual(useEngineView.getState().tabs, S().tabs);
    assert.equal(engineMark(useEngineView.getState(), id), null);
  } finally {
    stop();
  }
});

test("a cloned tab's badge follows its source even when the clone itself is unchanged", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://source.example" });
  const source = S().windows[w].activeTabIds.default;
  const clone = S().newTab(w, { url: "https://clone.example", background: true, adoptId: `clone:${source}` });
  S().updateTab(source, { engine: "webkit" });
  const tab = S().tabs[clone];
  assert.equal(engineMark(useEngineView.getState(), clone), "webkit");
  S().updateTab(source, { engine: "chromium" });
  assert.strictEqual(S().tabs[clone], tab);
  assert.equal(engineMark(useEngineView.getState(), clone), null);
});

test("engine selectors skip a tab switch's stamp and titles, and follow what selection reads", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://one.example" });
  const one = S().windows[w].activeTabIds.default;
  const two = S().newTab(w, { url: "https://two.example", background: true });
  let calls = 0;
  const stop = useEngineView.subscribe(() => calls++);

  try {
    S().activate(two);
    S().activate(one);
    S().updateTab(two, { title: "Another title" });
    assert.equal(calls, 0);
    S().updateTab(two, { url: "https://three.example" });
    assert.equal(calls, 1);
    assert.equal(useEngineView.getState().tabs[two].url, "https://three.example");
    S().updateTab(two, { openerId: one });
    assert.equal(calls, 2);
    S().updateTab(one, { engine: "webkit" });
    assert.equal(calls, 3);
    assert.equal(engineMark(useEngineView.getState(), two), "webkit", "a tab follows its opener's engine");
    S().closeTab(two);
    assert.equal(calls, 4);
    assert.equal(useEngineView.getState().tabs[two], undefined);
  } finally {
    stop();
  }
});

test("a restored tab takes its engine from its address, not the one it was saved with", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://example.com" });
  const id = S().windows[w].activeTabIds.default;
  S().updateTab(id, { engine: "webkit", url: "https://example.com/" });
  const saved = S();
  S().hydrate({ windows: saved.windows, tabs: saved.tabs, windowOrder: saved.windowOrder, spaces: saved.spaces, spaceOrder: saved.spaceOrder });
  assert.equal(S().tabs[id].engine, undefined);
  assert.equal(engineMark(useEngineView.getState(), id), null);
});
