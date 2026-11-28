// Loads pairs of data folders through the app's own loading (loadSession) and checks each pair hydrates to the same
// state: a folder the GPUI app's state crate wrote (packages/rust/bay-state/examples/resave.rs) against the one it read.
// docs/gpui-desktop-plan.html, D6.
//
//   node --no-warnings --import ./src/test-loader.mjs scripts/state-compare.mjs <read dir> <written dir> [...]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const folders = process.argv.slice(2);

if (!folders.length || folders.length % 2) {
  console.error("usage: state-compare.mjs <read dir> <written dir> [<read dir> <written dir> ...]");
  process.exit(2);
}

const stub = await import("../src/test-native-stub.mjs");
const { loadSession } = await import("../src/lib/persist.ts");

function loaded(dir) {
  stub.docs.clear();

  for (const name of ["session.json", "downloads.json"]) stub.docs.set(name, readFileSync(join(dir, name), "utf8"));

  return loadSession();
}

for (let i = 0; i < folders.length; i += 2) {
  assert.deepStrictEqual(loaded(folders[i + 1]), loaded(folders[i]));
  console.log(`${folders[i + 1]} loads as ${folders[i]} does`);
}
