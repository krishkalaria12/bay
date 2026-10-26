import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boostChanges,
  boostHost,
  boostUserCss,
  cleanSelector,
  colorCss,
  DEFAULT_BOOST_COLOR,
  engineBoosts,
  exportBoost,
  importBoost,
  invertTint,
  newBoost,
  normalizeBoost,
  shuffledBoost,
  tabBoostCss,
  tabBoostStyle,
  themedColor,
  tintMatrix,
} from "./boosts.ts";

const boost = (patch = {}) => ({ ...newBoost("b1", "news.example.com", 1000), ...patch });

test("boosts name a site by its host without www, and only web pages", () => {
  assert.equal(boostHost("https://www.Example.com/path?q=1"), "example.com");
  assert.equal(boostHost("http://news.ycombinator.com:8080/"), "news.ycombinator.com");
  for (const url of ["bay://library", "file:///tmp/a.html", "chrome://settings", "", undefined, "about:blank"]) assert.equal(boostHost(url), "", url);
});

test("a fresh boost changes nothing until edited", () => {
  assert.equal(boostChanges(boost()), false);
  assert.equal(boostChanges(boost({ zaps: [".ad"] })), true);
  assert.equal(boostChanges(boost({ css: "  " })), false);
  assert.equal(boostChanges(boost({ invert: true })), true);
});

test("normalizing drops what isn't a boost and keeps code out", () => {
  assert.equal(normalizeBoost(null), null);
  assert.equal(normalizeBoost({ id: "x" }), null);
  assert.equal(normalizeBoost({ id: "x", host: "javascript:alert(1)" }), null);
  const b = normalizeBoost({
    id: "x",
    host: "WWW.Example.com",
    name: "",
    zaps: [".a", ".a", "}{ body", 42, "div /* x */"],
    font: 'Evil"; } body { color: red',
    size: 99,
    textCase: "shout",
    script: "alert(1)",
    color: { accent: "nope", contrast: 4 },
  });
  assert.equal(b.host, "example.com");
  assert.equal(b.name, "My Boost");
  assert.deepEqual(b.zaps, [".a"]);
  assert.equal(b.font, "Evil  body  color: red");
  assert.equal(b.size, 3);
  assert.equal(b.textCase, "none");
  assert.equal("script" in b, false);
  assert.equal(b.color.accent, DEFAULT_BOOST_COLOR.accent);
  assert.equal(b.color.contrast, 1);
});

test("selectors can't end a rule early", () => {
  assert.equal(cleanSelector(" .ad "), ".ad");
  for (const bad of ["a { }", "a}", "/* x", "<script>", "a\\", "a\\\nbody", ".a)", '[title="unterminated]', "", 5])
    assert.equal(cleanSelector(bad), null, String(bad));
});

test("selector validation preserves CSS.escape identifiers without allowing rule injection", () => {
  for (const selector of ["div#promo\\:banner", ".ad\\[slot\\]", "#\\31 23", "#a\\{b\\}", "div#name\\ ", '[title="a{b}"]'])
    assert.equal(cleanSelector(selector), selector);
  assert.equal(cleanSelector(" div#name\\  "), "div#name\\ ");
  assert.equal(cleanSelector(" div#name\\\\ "), "div#name\\\\", "an escaped backslash does not escape trailing padding");
  for (const selector of [".a\\\\{color:red}", ".a\\5c {color:red}", ".a\\/*comment*/", ".a); body", ".a@import"])
    assert.equal(cleanSelector(selector), null, selector);
});

test("the user sheet hides zaps forgivingly and keeps them showable for the editor", () => {
  const css = boostUserCss(boost({ zaps: [".ad, .promo", "#side"] }));
  assert.match(css, /:is\(\.ad, \.promo\):not\(\[data-bay-unzap\]\) \{ display: none !important; \}/);
  assert.match(css, /:is\(#side\)/);
});

test("font, case, size and focus become important user rules", () => {
  const css = boostUserCss(boost({ font: "New York", textCase: "uppercase", size: 1.25, focus: ["article"] }));
  assert.match(css, /font-family: "New York", serif !important/);
  assert.match(css, /text-transform: uppercase !important/);
  assert.match(css, /html \{ zoom: 1\.25 !important; \}/);
  assert.match(css, /html:has\(:is\(article\)\) body \*:not\(:is\(article\), :is\(article\) \*, :has\(:is\(article\)\)\) \{ display: none !important; \}/);
  assert.match(boostUserCss(boost({ font: "Menlo" })), /"Menlo", monospace/);
});

test("the tint's inverse gives images their colours back", () => {
  const tint = tintMatrix(DEFAULT_BOOST_COLOR);
  const back = invertTint(tint);
  assert.ok(back);
  const apply = ({ m, b }, c) => m.map((row, i) => row[0] * c[0] + row[1] * c[1] + row[2] * c[2] + b[i]);
  for (const c of [
    [0.2, 0.4, 0.6],
    [0.9, 0.1, 0.3],
    [0.5, 0.5, 0.5],
  ]) {
    const round = apply(tint, apply(back, c));
    round.forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 1e-6, `${v} vs ${c[i]}`));
  }
  // White takes the light end, black the dark end, mixed in by the contrast.
  const white = apply(tint, [1, 1, 1]);
  const black = apply(tint, [0, 0, 0]);
  assert.ok(white.reduce((a, b) => a + b) > black.reduce((a, b) => a + b));
});

test("colour rules filter the page and give media the inverse", () => {
  const css = colorCss(DEFAULT_BOOST_COLOR);
  assert.match(css, /^html \{ filter: url\("data:image\/svg\+xml,[^"]+#t"\) !important; \}/);
  assert.match(
    css,
    /:is\(img, video, canvas, embed, object, iframe, bay-boost-picker, bay-boost-preview\) \{ filter: url\("data:image\/svg\+xml,[^"]+#u"\) !important; \}/,
  );
  assert.doesNotMatch(css, /[<>]/);
  // A boost following its space's colours leaves them to the tab's sheet.
  assert.doesNotMatch(boostUserCss(boost({ color: { ...DEFAULT_BOOST_COLOR, theme: true } })), /filter/);
});

test("the engine gets the boosts that are on, oldest first, scripts only when enabled", () => {
  const a = boost({ id: "a", createdAt: 2, css: "a{}" });
  const b = boost({ id: "b", createdAt: 1, invert: true });
  const off = boost({ id: "c", enabled: false });
  const scripts = { a: { code: "console.log(1)", enabled: true, privateWindows: true }, b: { code: "alert(1)", enabled: false, privateWindows: true } };
  const list = engineBoosts([a, b, off], scripts, true);
  assert.deepEqual(
    list.map((e) => [e.host, e.css, e.invert, e.scriptInPrivate]),
    [
      ["news.example.com", "", true, false],
      ["news.example.com", "a{}", false, true],
    ],
  );
  assert.equal(list[0].script, "");
  assert.equal(list[1].script, "(function () {\nconsole.log(1)\n})();");
  assert.deepEqual(engineBoosts([a, b], scripts, false), []);
});

test("the tab's sheet exposes only Bay's palette names", () => {
  const palette = {
    background: "#111111",
    backgroundExtra: "#222222",
    foreground: "#FFFFFF",
    foregroundSecondary: "#FFFFFF80",
    foregroundTertiary: "#FFFFFF59",
    accent: "#B5556B",
    hover: "#FFFFFF29",
    colors: ["#B5556B", "#4F7BE8"],
  };
  const css = tabBoostCss(palette);
  assert.match(css, /--bay-palette-background: #111111;/);
  assert.doesNotMatch(css, /--arc-/);
  assert.match(css, /--bay-palette-color1: #4F7BE8;/);
  assert.doesNotMatch(css, /filter/);
  const fixed = boost({ color: DEFAULT_BOOST_COLOR, createdAt: 1 });
  const themed = boost({ id: "theme", color: { ...DEFAULT_BOOST_COLOR, theme: true }, createdAt: 2 });
  const style = tabBoostStyle(palette, [themed, fixed], true);
  assert.equal(style.palette, css);
  assert.equal(style.sites[fixed.host], colorCss(themedColor(themed.color, palette.colors)), "newer theme wins over older fixed colour");
  assert.equal(tabBoostStyle(palette, [themed, { ...fixed, createdAt: 3 }], true).sites[fixed.host], colorCss(fixed.color));
  assert.deepEqual(tabBoostStyle(palette, [fixed, themed], false), { palette: css, sites: {} });
  assert.doesNotMatch(
    engineBoosts([fixed, themed], {}, true)
      .map((b) => b.userCss)
      .join("\n"),
    /filter:/,
  );
  // Equal timestamps resolve by id, independent of arrival order on another Mac.
  assert.deepEqual(tabBoostStyle(palette, [fixed, { ...themed, createdAt: 1 }], true), tabBoostStyle(palette, [{ ...themed, createdAt: 1 }, fixed], true));
});

test("shuffle changes the look only", () => {
  let n = 0;
  const random = () => ((n = (n * 7 + 3) % 11), n / 11);
  const b = boost({ zaps: [".x"], css: "a{}" });
  const s = shuffledBoost(b, random);
  assert.ok(s.color);
  assert.deepEqual(s.zaps, [".x"]);
  assert.equal(s.css, "a{}");
});

test("export and import round-trip, with the script separate", () => {
  const b = boost({ name: "Calm", zaps: [".ad"], css: "body{}", font: "Georgia" });
  const json = exportBoost(b, { code: "x()", enabled: true, privateWindows: false });
  assert.doesNotMatch(json, /"id"/);
  const back = importBoost(json, "new", "other.com", 5);
  assert.equal(back.boost.id, "new");
  assert.equal(back.boost.host, "news.example.com");
  assert.equal(back.boost.name, "Calm");
  assert.deepEqual(back.boost.zaps, [".ad"]);
  assert.equal(back.script, "x()");
  assert.equal(importBoost("not json", "n", "a.com", 1), null);
  assert.equal(importBoost("{}", "n", "a.com", 1), null);
});

test("Zen's boost files import for the current site", () => {
  const zen = JSON.stringify({
    boostName: "Zen",
    dotAngleDeg: 200,
    enableColorBoost: true,
    smartInvert: true,
    fontFamily: "Georgia",
    textCaseOverride: "uppercase",
    sizeOverride: 1.1,
    zapSelectors: [".banner"],
    focusSelectors: [],
    customCSS: "p{}",
    saturation: 0.25,
  });
  const { boost: b, script } = importBoost(zen, "z", "zen.example", 1);
  assert.equal(b.host, "zen.example");
  assert.equal(b.name, "Zen");
  assert.equal(b.invert, true);
  assert.equal(b.textCase, "uppercase");
  assert.equal(b.size, 1.1);
  assert.deepEqual(b.zaps, [".banner"]);
  assert.equal(b.css, "p{}");
  assert.equal(b.color.saturation, 0.75);
  assert.equal(script, "");
});
