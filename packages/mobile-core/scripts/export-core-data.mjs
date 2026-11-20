// Writes data/units.json, data/emoji.json and data/bangs.txt from @bay/core's tables (the calculator's units, the
// emoji list, the bang list), which the core compiles in. Run after any of them changes:
//   node packages/mobile-core/scripts/export-core-data.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "../../core/src");
const { UNIT_CATEGORIES } = await import(join(core, "vendor/supercalculator/units.ts"));
const { EMOJI_GROUPS } = await import(join(core, "emoji.ts").replace("emoji.ts", "emojiData.ts"));
const { BANG_LIST, BANG_LIST_UNICODE } = await import(join(core, "bangList.ts"));

const units = UNIT_CATEGORIES.map((category) => ({
  name: category.name,
  base: category.base,
  // Each alias with its definition, in the table's order: the calculator's pattern tries the longest first.
  units: Object.entries(category.units).map(([alias, def]) => {
    const unit = { alias, factor: def.factor, name: def.name };

    if (def.offset !== undefined) unit.offset = def.offset;

    return unit;
  }),
}));

writeFileSync(join(here, "../data/units.json"), `${JSON.stringify(units)}\n`);

writeFileSync(join(here, "../data/emoji.json"), `${JSON.stringify(EMOJI_GROUPS.flatMap((group) => group.emoji))}\n`);

// The two lists joined: a trigger in both keeps its first site, as the desktop's joined tables do.
writeFileSync(join(here, "../data/bangs.txt"), `${BANG_LIST}\n${BANG_LIST_UNICODE}\n`);

console.log(`${units.length} unit categories, ${EMOJI_GROUPS.flatMap((g) => g.emoji).length} emoji`);
