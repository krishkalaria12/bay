// The theme editor's colour field and a space's own theme as the window's.
import assert from "node:assert/strict";
import { test } from "node:test";
const { defaultHarmony, editableTheme, harmonize, harmonyAfterRemoving, nextHarmony, wheelColor, wheelPosition } = await import("./spaceTheme.ts");
const { hslOf } = await import("./windowTint.ts");
const { spaceThemeKey, themeFor } = await import("./theme.ts");

test("a colour picked on the wheel puts its dot back where it was picked", () => {
  for (const [angle, distance] of [
    [0.1, 0.2],
    [0.5, 0.5],
    [0.83, 0.9],
  ]) {
    const at = wheelPosition(wheelColor(angle, distance));
    assert.ok(Math.abs(at.angle - angle) < 0.01 && Math.abs(at.distance - distance) < 0.01, `${angle},${distance} → ${at.angle},${at.distance}`);
  }
  assert.match(wheelColor(-0.25, 2), /^#[0-9A-F]{6}$/, "past the edge, or a turn back: still a colour");
  assert.ok(hslOf(wheelColor(0, 0))[2] < hslOf(wheelColor(0, 1))[2], "dark in the middle, light at the edge");
});

test("harmonies place the other colours round the wheel from the first, as light as it is", () => {
  assert.equal(defaultHarmony(1), "floating");
  assert.equal(defaultHarmony(2), "complementary");
  assert.equal(defaultHarmony(3), "splitComplementary");
  const first = wheelColor(0.1, 0.6);
  const [a, b] = harmonize(first, "complementary");
  assert.equal(a, first);
  const hue = (c) => hslOf(c)[0];
  assert.ok(Math.abs(((hue(b) - hue(a) + 1) % 1) - 0.5) < 0.01, "opposite");
  assert.ok(Math.abs(hslOf(b)[2] - hslOf(a)[2]) < 0.01, "as light");
  const triad = harmonize(first, "triadic").map(hue);
  assert.ok(Math.abs(((triad[1] - triad[0] + 1) % 1) - 1 / 3) < 0.01 && Math.abs(((triad[2] - triad[0] + 1) % 1) - 2 / 3) < 0.01);
  assert.deepEqual(harmonize(first, "floating"), [first]);
});

test("the harmony button goes round the ones for the colours there are; removing one keeps it near", () => {
  assert.equal(nextHarmony("complementary", 2), "singleAnalogous");
  assert.equal(nextHarmony("singleAnalogous", 2), "complementary");
  assert.equal(nextHarmony("splitComplementary", 3), "analogous");
  assert.equal(nextHarmony("analogous", 3), "triadic");
  assert.equal(nextHarmony("triadic", 3), "splitComplementary");
  assert.equal(harmonyAfterRemoving("analogous", 2), "singleAnalogous");
  assert.equal(harmonyAfterRemoving("triadic", 2), "complementary");
  assert.equal(harmonyAfterRemoving("complementary", 1), "floating");
});

test("a space without its own theme keeps its preset's key; one with a theme gets its own", () => {
  assert.equal(spaceThemeKey({ color: "blue", theme: null }, true), "blue:dark");
  assert.equal(
    spaceThemeKey({ color: "blue", theme: { colors: ["#FF7E5F", "#FEB47B"], intensity: 0.5, grain: 0.3 } }, false),
    "custom|#FF7E5F,#FEB47B|0.50|0.30:light",
  );
  assert.deepEqual(editableTheme(null, "#4691c3"), { colors: ["#4691C3"], intensity: 0.5, grain: 0.3 });
});

test("a custom theme tints the window with its gradient, as strongly as its intensity says", () => {
  const soft = themeFor(spaceThemeKey({ color: "plum", theme: { colors: ["#FF7E5F", "#0DB4F7"], intensity: 0.1, grain: 0 } }, true));
  const strong = themeFor(spaceThemeKey({ color: "plum", theme: { colors: ["#FF7E5F", "#0DB4F7"], intensity: 0.9, grain: 1 } }, true));
  assert.notEqual(strong.windowTint[0], strong.windowTint[1], "two colours: a gradient");
  assert.ok(strong.backdrop.tintAlpha > soft.backdrop.tintAlpha);
  assert.equal(soft.grain, 0);
  assert.ok(strong.grain > 0);
  assert.deepEqual(strong.lightPalette, ["#FF7E5F", "#0DB4F7"]);
  assert.equal(strong.dark, true);
});

test("dragging through many custom themes keeps only the latest few", () => {
  for (let i = 0; i < 200; i++) themeFor(spaceThemeKey({ color: "plum", theme: { colors: [wheelColor(i / 200, 0.5)], intensity: 0.5, grain: 0.3 } }, true));
  const again = themeFor(spaceThemeKey({ color: "plum", theme: { colors: [wheelColor(199 / 200, 0.5)], intensity: 0.5, grain: 0.3 } }, true));
  assert.ok(again.windowTint[0].startsWith("#"));
});

test("a solid window over a page with a colour fills with it, in the look that reads on it", () => {
  const google = themeFor("plum:dark@#202124");
  assert.deepEqual(google.windowTint, ["#202124", "#202124"]);
  assert.equal(google.dark, true);
  assert.equal(google.glass, false);
  const white = themeFor("plum:light@#FFFFFF");
  assert.deepEqual(white.windowTint, ["#FFFFFF", "#FFFFFF"]);
  assert.equal(white.dark, false);
});

test("a space's own theme shows over a page with a colour; a preset colour gives way to the page", async () => {
  const { useBrowser } = await import("../store/browser.ts");
  const { themeKey } = await import("./theme.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const space = S().settings.defaultSpaceId;
  // A new install's space has a theme (Twilight); from a preset colour, the page's shows instead.
  assert.ok(S().spaces[space].theme);
  S().updateSpace(space, { theme: null });
  const w = S().createWindow({ spaceId: space, url: "https://example.com" });
  const tab = S().windows[w].activeTabIds[space];
  useBrowser.setState({ live: { ...S().live, [tab]: { ...S().live[tab], themeColor: "#202124" } } });
  assert.match(themeKey(S(), w, null), /@#202124$/);
  S().updateSpace(space, { theme: { colors: ["#F27AA0", "#B04FD0"], intensity: 0.9, grain: 0.5 } });
  assert.match(themeKey(S(), w, null), /^custom\|#F27AA0,#B04FD0\|0\.90\|0\.50:(light|dark)$/);
});
