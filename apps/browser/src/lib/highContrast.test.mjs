// High contrast (prefers-contrast: more) on web hosts: detection, and a theme whose text reads on every window.
import assert from "node:assert/strict";
import { test } from "node:test";

const changes = [];
globalThis.matchMedia = (query) => ({ matches: query === "(prefers-contrast: more)", addEventListener: (_type, listener) => changes.push(listener) });
const { useHighContrast } = await import("./highContrast.ts");
const { SPACE_COLORS, hex, themeFor, themeKey } = await import("./theme.ts");

const channels = (color) => {
  const c = hex(color);
  const at = (i) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return [at(0), at(1), at(2), c.length > 7 ? at(3) / 255 : 1];
};
const luminance = (color, under = "#000000") => {
  const [r, g, b, a] = channels(color);
  const [R, G, B] = channels(under);
  const linear = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r * a + R * (1 - a)) + 0.7152 * linear(g * a + G * (1 - a)) + 0.0722 * linear(b * a + B * (1 - a));
};
const ratio = (text, background) => {
  const [a, b] = [luminance(text, background), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const TEXT = ["textPrimary", "textTab", "textSecondary", "textTertiary", "icon", "placeholder", "chipText"];

// Just what themeKey reads: one window on space "a", whose shown tab reports a mid-tone page colour.
const state = (space, { glass = false, dark = false } = {}) => ({
  windows: { w: { spaceId: "a", activeTabIds: { a: "t" } } },
  tabs: { t: { url: "https://example.com", windowId: "w", spaceId: "a" } },
  live: { t: { themeColor: "#D92680" } },
  spaces: { a: space },
  settings: { windowMaterial: glass ? "glass" : "solid", defaultSpaceId: "a" },
  ui: { appDark: dark, focusedWindowId: "w" },
});

test("the desktop's setting is read, and followed when it changes", () => {
  assert.equal(useHighContrast.getState(), true);
  for (const listener of changes) listener({ matches: false });
  assert.equal(useHighContrast.getState(), false);
  for (const listener of changes) listener({ matches: true });
  assert.equal(useHighContrast.getState(), true);
});

test("high contrast text meets WCAG AA on every window and panel", () => {
  const spaces = Object.keys(SPACE_COLORS).map((color) => ({ color }));
  for (const colors of [["#000000"], ["#FFFFFF"], ["#808080"], ["#FF7E5F", "#0DB4F7"], ["#FFFF00", "#D92680"]])
    spaces.push({ color: "plum", theme: { colors, intensity: 1, grain: 1 } });
  for (const space of spaces) {
    for (const dark of [false, true]) {
      const theme = themeFor(themeKey(state(space, { dark }), "w", null, {}, true));
      for (const background of [...theme.windowTint, theme.panel]) {
        for (const token of TEXT) {
          const r = ratio(theme[token], background);
          assert.ok(r >= 4.5, `${JSON.stringify(space)} ${dark ? "dark" : "light"}: ${token} ${theme[token]} on ${background} is ${r.toFixed(2)}`);
        }
      }
    }
  }
});

test("high contrast makes the window solid in its space's colour; off, nothing changes", () => {
  const plum = { color: "plum" };
  const off = themeKey(state(plum, { glass: true }), "w", null, {}, false);
  assert.equal(off, "plum:light:glass");
  assert.equal(themeKey(state(plum, { glass: true }), "w", null, {}, true), "plum:light!contrast");
  assert.match(themeKey(state(plum), "w", null, {}, false), /@#/, "a solid window takes its page's colour");
  assert.equal(themeKey(state(plum), "w", null, {}, true), "plum:light!contrast", "but not in high contrast");
  assert.equal(themeFor(off).textSecondary, "#00000080");
  assert.equal(themeFor(off).grain, themeFor("plum:light").grain);
});
