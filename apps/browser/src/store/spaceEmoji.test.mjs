// Every space shows an emoji: a new one gets a free one, an older session's without one gets one, and none is cleared.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const { SPACE_EMOJI } = await import("./spaces.ts");
const S = () => useBrowser.getState();
const space = (id, icon) => ({ id, name: id, color: "blue", icon, createdAt: 0 });

test("a space made without an icon gets an emoji no other space has", () => {
  S().hydrate({});
  const ids = [S().createSpace({ name: "Work" }), S().createSpace({ name: "Side", icon: null })];
  const icons = S().spaceOrder.map((id) => S().spaces[id].icon);
  for (const id of ids) assert.ok(SPACE_EMOJI.includes(S().spaces[id].icon));
  assert.equal(new Set(icons).size, icons.length, "each space's emoji is its own");
  const chosen = S().createSpace({ name: "Chosen", icon: "🚀" });
  assert.equal(S().spaces[chosen].icon, "🚀", "a chosen emoji is kept");
});

test("an older session's spaces without an icon get one, and symbols and emoji stay", () => {
  S().hydrate({ spaces: { a: space("a", null), b: space("b", "🎧"), c: space("c", "symbol:briefcase.fill") }, spaceOrder: ["a", "b", "c"] });
  assert.ok(SPACE_EMOJI.includes(S().spaces.a.icon));
  assert.notEqual(S().spaces.a.icon, "🎧");
  assert.equal(S().spaces.b.icon, "🎧");
  assert.equal(S().spaces.c.icon, "symbol:briefcase.fill");
});

test("an update can't take a space's icon away", () => {
  S().hydrate({ spaces: { a: space("a", "🎧") }, spaceOrder: ["a"] });
  S().updateSpace("a", { icon: null, name: "Music" });
  assert.equal(S().spaces.a.icon, "🎧");
  assert.equal(S().spaces.a.name, "Music");
  S().updateSpace("a", { icon: "🎮" });
  assert.equal(S().spaces.a.icon, "🎮");
});
