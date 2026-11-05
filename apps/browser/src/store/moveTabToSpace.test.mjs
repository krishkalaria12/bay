import assert from "node:assert/strict";
import { test } from "node:test";
await import("../test-native-stub.mjs");
const { useBrowser } = await import("./browserStore.ts");
const { dropTabsOutside } = await import("../components/window/windowDrop.ts");

const S = () => useBrowser.getState();
const shown = (w) => S().windows[w].activeTabIds[S().windows[w].spaceId];

function twoSpaces() {
  S().hydrate({});
  const left = S().createWindow({ url: "https://a1.example", frame: [0, 0, 400, 400] });
  const moving = shown(left);
  const staying = S().newTab(left, { url: "https://a2.example", background: true });
  const space = S().createSpace({ name: "Right" });
  const right = S().createWindow({ spaceId: space, url: "https://b1.example", frame: [1000, 0, 400, 400] });
  return { left, right, space, moving, staying, home: S().windows[left].spaceId };
}

test("a tab moved to a space, shown in that space's window, leaves its old window on its own space", () => {
  const f = twoSpaces();
  S().moveTabToSpace(f.moving, f.space, f.right);
  assert.equal(S().tabs[f.moving].spaceId, f.space);
  assert.equal(S().tabs[f.moving].windowId, f.right);
  assert.equal(S().windows[f.right].spaceId, f.space);
  assert.equal(shown(f.right), f.moving);
  assert.equal(S().windows[f.left].spaceId, f.home, "the window it left stays on its space");
  assert.equal(shown(f.left), f.staying);
  assert.ok(S().tabLists[f.space].includes(f.moving));
  assert.ok(!S().tabLists[f.home].includes(f.moving));
});

test("moved from its own window, a tab takes the window to its new space", () => {
  const f = twoSpaces();
  S().moveTabToSpace(f.moving, f.space);
  assert.equal(S().windows[f.left].spaceId, f.space);
  assert.equal(shown(f.left), f.moving);
});

test("dropped on another space's strip a tab joins that space; dropped elsewhere on the window it takes the window along", () => {
  const f = twoSpaces();
  assert.equal(dropTabsOutside([f.moving], f.left, 1100, 100, undefined, null, f.right), f.right);
  assert.equal(S().tabs[f.moving].spaceId, f.space);
  assert.equal(S().windows[f.right].spaceId, f.space);
  assert.equal(S().windows[f.left].spaceId, f.home);

  const g = twoSpaces();
  assert.equal(dropTabsOutside([g.moving], g.left, 1100, 100, undefined, null), g.right);
  assert.equal(S().tabs[g.moving].spaceId, g.home);
  assert.equal(S().windows[g.right].spaceId, g.home);
});

test("tearing one pane into a new window dissolves its two-pane split", () => {
  const f = twoSpaces();
  const split = S().createSplit([f.moving, f.staying]);
  const target = S().moveTabsToWindow([f.moving], null);
  assert.ok(target);
  assert.equal(S().splits[split], undefined);
  assert.equal(S().tabs[f.moving].windowId, target);
  assert.equal(shown(target), f.moving);
  assert.equal(shown(f.left), f.staying);
  assert.ok(S().tabLists[f.home].includes(f.moving), "the torn-off tab stays in its space");
});

test("moving a pane to another window keeps the remaining panes and their sizes", () => {
  const f = twoSpaces();
  const third = S().newTab(f.left, { url: "https://a3.example", background: true });
  const split = S().createSplit([f.moving, f.staying, third]);
  S().updateSplit(split, { sizes: [0.2, 0.3, 0.5] });
  S().moveTabsToWindow([third], f.right);
  assert.deepEqual(S().splits[split].tabIds, [f.moving, f.staying]);
  assert.deepEqual(S().splits[split].sizes, [0.4, 0.6]);
  assert.equal(S().tabs[third].windowId, f.right);
});

test("moving all panes to a new window keeps their split intact", () => {
  const f = twoSpaces();
  const split = S().createSplit([f.moving, f.staying]);
  const before = S().splits[split];
  const target = S().moveTabsToWindow([f.moving, f.staying], null);
  assert.equal(S().splits[split], before);
  assert.equal(S().tabs[f.moving].windowId, target);
  assert.equal(S().tabs[f.staying].windowId, target);
});
