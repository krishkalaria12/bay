import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const symbols = readFileSync(new URL("../../../packages/shell/src/symbols.web.tsx", import.meta.url), "utf8");
const generated = readFileSync(new URL("../../../packages/shell/src/lucideSymbols.web.ts", import.meta.url), "utf8");
const aliasTable = symbols.match(/const aliases: Record<string, string> = \{([^}]+)\}/)?.[1] ?? "";
const paths = new Set([...generated.matchAll(/^ {2}"([\w.]+)": \[/gm)].map((match) => match[1]));
const aliases = Object.fromEntries([...aliasTable.matchAll(/"?([\w.]+)"?: "([\w.]+)"/g)].map((match) => [match[1], match[2]]));

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

// Linux draws SF Symbol names from the Lucide icons in lucideSymbols.web.ts. A name with none falls back to
// exclamationmark.circle, so every name the app uses needs one.
test("every symbol the app names has a web icon", () => {
  assert.ok(paths.size > 50 && Object.keys(aliases).length > 0, "symbol tables found");
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
    const base = name.replace(/\.fill$/, ""); // svgSymbol draws .fill names from the same icon
    if (!paths.has(aliases[base] ?? base)) undrawn.add(base);
  }
  assert.deepEqual([...undrawn].sort(), []);
});
