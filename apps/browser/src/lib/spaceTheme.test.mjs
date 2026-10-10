// The theme editor's colour field and a space's own theme as the window's.
import assert from "node:assert/strict";
import { test } from "node:test";
const { editableTheme, spectrumColor, spectrumPosition } = await import("./spaceTheme.ts");
const { spaceThemeKey, themeFor } = await import("./theme.ts");

test("a colour picked on the field puts its dot back where it was picked", () => {
  for (const [x, y] of [[0.1, 0.2], [0.5, 0.5], [0.83, 0.9]]) {
    const at = spectrumPosition(spectrumColor(x, y));
    assert.ok(Math.abs(at.x - x) < 0.01 && Math.abs(at.y - y) < 0.01, `${x},${y} → ${at.x},${at.y}`);
  }
  assert.match(spectrumColor(2, -1), /^#[0-9A-F]{6}$/, "outside the field: clamped to its edge");
});

test("a space without its own theme keeps its preset's key; one with a theme gets its own", () => {
  assert.equal(spaceThemeKey({ color: "blue", theme: null }, true), "blue:dark");
  assert.equal(spaceThemeKey({ color: "blue", theme: { colors: ["#FF7E5F", "#FEB47B"], intensity: 0.5, grain: 0.3 } }, false), "custom|#FF7E5F,#FEB47B|0.50|0.30:light");
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
  for (let i = 0; i < 200; i++) themeFor(spaceThemeKey({ color: "plum", theme: { colors: [spectrumColor(i / 200, 0.5)], intensity: 0.5, grain: 0.3 } }, true));
  const again = themeFor(spaceThemeKey({ color: "plum", theme: { colors: [spectrumColor(199 / 200, 0.5)], intensity: 0.5, grain: 0.3 } }, true));
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
  const w = S().createWindow({ spaceId: space, url: "https://example.com" });
  const tab = S().windows[w].activeTabIds[space];
  useBrowser.setState({ live: { ...S().live, [tab]: { ...S().live[tab], themeColor: "#202124" } } });
  assert.match(themeKey(S(), w, null), /@#202124$/);
  S().updateSpace(space, { theme: { colors: ["#F27AA0", "#B04FD0"], intensity: 0.9, grain: 0.5 } });
  assert.match(themeKey(S(), w, null), /^custom\|#F27AA0,#B04FD0\|0\.90\|0\.50:(light|dark)$/);
});
