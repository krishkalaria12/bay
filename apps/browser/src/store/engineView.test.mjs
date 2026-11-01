import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "./browser.ts";
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
    S().updateSettings({ pageEngine: "webkit" });
    assert.equal(calls, 2);
    assert.equal(engineMark(useEngineView.getState(), id), null);
    S().hydrate({});
    assert.strictEqual(useEngineView.getState().tabs, S().tabs);
    assert.strictEqual(useEngineView.getState().settings, S().settings);
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
