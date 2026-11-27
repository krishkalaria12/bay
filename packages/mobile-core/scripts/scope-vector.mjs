// Writes fixtures/scope-chain.json: a chain three TypeScript devices built in one folder (edits, deletes, crashes and
// compaction, with packages/sync/src/scope.ts), and the records a fresh TypeScript device reads from it. The Rust tests
// read the same files with a fresh device and must end with the same records.
//   node packages/mobile-core/scripts/scope-vector.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { Clock } = await import(join(here, "../../sync/src/hlc.ts"));
const { emptyScope, syncScope } = await import(join(here, "../../sync/src/scope.ts"));

const files = new Map();
let counter = 0;
let now = 1_700_000_000_000;

const transport = {
  write: async (_scope, payload) => {
    const id = `f${++counter}`;

    files.set(id, payload);

    return id;
  },
  read: async (_scope, known) => ({
    files: [...files].flatMap(([id, payload]) => (known.includes(id) ? [] : [{ id, payload }])),
    pending: [],
    damaged: [],
    present: [...files.keys()],
  }),
  remove: async (_scope, ids) => {
    for (const id of ids) files.delete(id);
  },
};

function device(id) {
  const store = new Map();
  const state = emptyScope();
  const clock = new Clock(id, null, () => now);

  const adapters = [
    {
      prefix: "x:",
      extract: () => ({ values: new Map(store) }),
      apply: (visible, changed) => {
        for (const key of changed) {
          const value = visible.get(key);

          if (value !== undefined) store.set(key, value);
          else store.delete(key);
        }
      },
    },
  ];

  const options = { compactAfterFiles: 6, compactInterval: 0, pruneGrace: 0, tombstoneTTL: 50_000 };

  return { id, store, state, sync: () => syncScope({ scope: "s", state, transport, adapters, clock, device: id, now: () => now, options }) };
}

let seed = 11;

const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const devices = ["devA", "devB", "devC"].map(device);

for (let step = 0; step < 120; step++) {
  now += Math.floor(random() * 2000);
  const d = devices[Math.floor(random() * 3)];
  const key = `x:${Math.floor(random() * 8)}`;
  const r = random();

  if (r < 0.45) d.store.set(key, { by: d.id, step, tags: ["a", step % 3 === 0 ? "b" : "c"], nested: { z: 1, a: null } });
  else if (r < 0.65) d.store.delete(key);
  else await d.sync();
}

for (let round = 0; round < 2; round++) for (const d of devices) await d.sync();

const reader = device("devR");

await reader.sync();

writeFileSync(
  join(here, "../fixtures/scope-chain.json"),
  `${JSON.stringify(
    { files: [...files].map(([id, payload]) => ({ id, payload })), records: reader.state.records, store: Object.fromEntries(reader.store), now },
    null,
    1,
  )}\n`,
);

console.log(`${files.size} files, ${Object.keys(reader.state.records).length} records`);
