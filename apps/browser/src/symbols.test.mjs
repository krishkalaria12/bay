import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Windows and Linux draw SF Symbol names from the inline paths in symbols.web.tsx. A name with no path falls
// back to exclamationmark.circle. These still have none; draw one and take it off the list.
const UNDRAWN = [
  "airplane",
  "alarm",
  "anchor",
  "ant",
  "antenna.radiowaves.left.and.right.slash",
  "atom",
  "bag",
  "banknote",
  "basketball",
  "battery.100.bolt",
  "battery.25",
  "beach.umbrella",
  "bell",
  "bicycle",
  "bird",
  "bolt",
  "brain",
  "brain.head.profile",
  "briefcase",
  "bubble.left.and.bubble.right",
  "building.2",
  "calendar",
  "calendar.badge.plus",
  "car",
  "cart",
  "cat",
  "chart.bar",
  "chart.line.uptrend.xyaxis",
  "chart.pie",
  "cloud",
  "cpu",
  "cross.case",
  "crown",
  "cup.and.saucer",
  "desktopcomputer",
  "dice",
  "dog",
  "dollarsign.circle",
  "dot.radiowaves.left.and.right",
  "drop",
  "dumbbell",
  "envelope",
  "externaldrive",
  "eye",
  "eyeglasses",
  "eye.slash",
  "face.smiling",
  "figure.2.and.child.holdinghands",
  "figure.run",
  "finder",
  "fish",
  "flag",
  "flame",
  "flask",
  "fork.knife",
  "gamecontroller",
  "gift",
  "globe.americas",
  "graduationcap",
  "guitars",
  "gyroscope",
  "hammer",
  "hand.raised",
  "heart",
  "internaldrive",
  "key",
  "keyboard",
  "ladybug",
  "leaf",
  "lightbulb",
  "lock.shield",
  "map",
  "mappin.and.ellipse",
  "moon",
  "moon.stars",
  "mountain.2",
  "network",
  "pawprint",
  "person.2",
  "person.badge.key",
  "person.crop.circle.badge.clock",
  "phone",
  "photo",
  "pianokeys",
  "puzzlepiece",
  "safari",
  "server.rack",
  "shield",
  "shield.lefthalf.filled",
  "shippingbox",
  "snowflake",
  "soccerball",
  "sportscourt",
  "sun.max",
  "terminal",
  "testtube.2",
  "tree",
  "trophy",
  "visionpro",
  "wineglass",
  "wrench.and.screwdriver",
];

const root = fileURLToPath(new URL(".", import.meta.url));
const symbols = readFileSync(new URL("../../../packages/shell/src/symbols.web.tsx", import.meta.url), "utf8");
const table = (name) => symbols.match(new RegExp(`const ${name}: Record<string, string> = \\{([^}]+)\\}`))?.[1] ?? "";
const paths = new Set([...table("paths").matchAll(/^\s+"?([\w.]+)"?:/gm)].map((match) => match[1]));
const aliases = Object.fromEntries([...table("aliases").matchAll(/"?([\w.]+)"?: "([\w.]+)"/g)].map((match) => [match[1], match[2]]));

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}
// A symbol-valued key or prop (icon:, symbol=, <Symbol name=...), then the literals in value position of its
// expression, so `icon: done ? "checkmark" : "clock"` yields both and `weight="bold"` later on the line yields none.
const symbolProp = /\b(?:icon|symbol|systemName|glyph)\w*\s*[:=]\s*\{?([^,;\n]*)|<Symbol name=\{?([^,;\n]*)/gi;
const symbolName = /(?:^|[?:|]\s*)"([a-z][a-z0-9]*(?:\.[a-z0-9]+)*)"/g;
// The icons people choose for spaces, profiles and pinned tabs, listed as data rather than as props.
const PICKERS = [
  ["components/sidebar/IconPicker.tsx", /const SYMBOLS: IconChoice\[\] = \[([^\]]+)\]/, /"([^"]+)"/g],
  ["components/spaces/icons.tsx", /const SPACE_SET[^=]+= \[([\s\S]+?)\n\];/, /\["([^"]+)"/g],
  ["components/symbolColors.ts", /const BY_COLOR[^=]+= \[([\s\S]+?)\n\];/, /"([^"]+)"/g],
];

test("every symbol the app names has a web path", () => {
  assert.ok(paths.size > 50 && Object.keys(aliases).length > 0, "symbols.web.tsx tables found");
  const names = [];
  for (const path of sources(root)) {
    for (const prop of readFileSync(path, "utf8").matchAll(symbolProp)) {
      for (const [, name] of (prop[1] ?? prop[2]).matchAll(symbolName)) names.push(name);
    }
  }
  for (const [file, list, name] of PICKERS) {
    const body = readFileSync(join(root, file), "utf8").match(list)?.[1];
    assert.ok(body, `${file} symbol list found`);
    for (const match of body.matchAll(name)) names.push(match[1]);
  }
  const undrawn = new Set();
  for (const name of names) {
    const base = name.replace(/\.fill$/, ""); // svgSymbol draws .fill names from their outline
    if (!paths.has(aliases[base] ?? base)) undrawn.add(base);
  }
  assert.deepEqual([...undrawn].sort(), [...UNDRAWN].sort());
});
