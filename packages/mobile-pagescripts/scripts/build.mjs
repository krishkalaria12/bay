#!/usr/bin/env node
// Writes resources/pagescripts.json, the page scripts both apps bundle (D13 in docs/mobile-native-plan.html): every
// `*_SCRIPT` src exports, keyed by its name in kebab case (WATCH_MEDIA_SCRIPT is "watch-media"). A script that takes
// arguments reads them from `args`, which the app declares ahead of it as `const args = <JSON>;` (withArgs).
//
// Run after changing a page script: node packages/mobile-pagescripts/scripts/build.mjs
// --check fails instead of writing when the file is out of date (tests/resources.test.ts runs it).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sources = join(here, "../src");
const output = join(here, "../resources/pagescripts.json");

const scripts = {};

for (const file of readdirSync(sources)
  .filter((name) => name.endsWith(".ts"))
  .sort()) {
  const module = await import(pathToFileURL(join(sources, file)).href);

  // Every `*_SCRIPT` export is a script's text.
  for (const [name, source] of Object.entries(module).filter(([name]) => name.endsWith("_SCRIPT"))) {
    // A Windows checkout has CRLF sources, but the scripts are the same either way.
    scripts[name.slice(0, -"_SCRIPT".length).toLowerCase().replaceAll("_", "-")] = source.replaceAll("\r\n", "\n").trim() + "\n";
  }
}

const sorted = Object.fromEntries(Object.entries(scripts).sort(([a], [b]) => (a < b ? -1 : 1)));
const text = JSON.stringify(sorted, null, 1) + "\n";

if (process.argv.includes("--check")) {
  let current = "";

  try {
    current = readFileSync(output, "utf8").replaceAll("\r\n", "\n");
  } catch {
    // Missing: out of date.
  }

  if (current !== text) {
    console.error("packages/mobile-pagescripts/resources/pagescripts.json is out of date: run node packages/mobile-pagescripts/scripts/build.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(output, text);
  console.log(`wrote resources/pagescripts.json (${Object.keys(sorted).length} scripts, ${Math.round(text.length / 1024)} KB)`);
}
