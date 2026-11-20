// Writes strings/<locale>.json from the Expo app's TypeScript tables (apps/mobile/src/i18n). The JSON files are the
// native apps' catalog; until the Expo app is retired, run this after its strings change so both read the same words:
//   node packages/mobile-core/scripts/import-expo-strings.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { CATALOG } = await import(join(here, "../../../apps/mobile/src/i18n/messages.ts"));

for (const [locale, strings] of Object.entries(CATALOG)) {
  const sorted = Object.fromEntries(Object.entries(strings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(join(here, "../strings", `${locale}.json`), `${JSON.stringify(sorted, null, 2)}\n`);
}
