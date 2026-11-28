// Writes the app's default settings (store/settings.ts DEFAULT_SETTINGS) as JSON, for the GPUI app's state crate to
// read a setting nobody saved the way this app does (packages/rust/bay-state/src/store/default_settings.json).
//
//   node --no-warnings --import ./src/test-loader.mjs scripts/default-settings.mjs <out file>
import { writeFileSync } from "node:fs";

const out = process.argv[2];

if (!out) {
  console.error("usage: default-settings.mjs <out file>");
  process.exit(2);
}

await import("../src/test-native-stub.mjs");

const { DEFAULT_SETTINGS } = await import("../src/store/settings.ts");

writeFileSync(out, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);

console.log(`wrote ${out}`);
