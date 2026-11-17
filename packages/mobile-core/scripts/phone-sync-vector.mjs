// Writes fixtures/phone-sync.json: the Expo app's phone sync (apps/mobile/src/sync) against a stand-in computer, as
// tests/phoneSync.test.ts runs it, with the phone's resulting state and every record the computer reads back. The
// Rust phone (crates/bay-core/src/sync/phone) runs the same steps and must end the same way.
//   node packages/mobile-core/scripts/phone-sync-vector.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "../../../apps/mobile/src");
const { Clock } = await import(join(here, "../../sync/src/hlc.ts"));
const { emptyScope, syncScope, visible } = await import(join(here, "../../sync/src/scope.ts"));
const { newDoc, runCycle } = await import(join(app, "sync/engine.ts"));
const { createTab, HISTORY_LIMIT, initialBrowserData, reduceBrowserData } = await import(join(app, "store/model.ts"));
const computerRecords = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(here, "../fixtures/phone-sync-computer.json"), "utf8")));
const NOW = computerRecords.now;

const files = new Map();
let counter = 0;

const transport = {
  write: async (scope, payload) => {
    const id = `f${++counter}`;

    files.set(`${scope}/${id}`, payload);

    return id;
  },
  read: async (scope, known) => {
    const listing = { files: [], pending: [], damaged: [], present: [] };

    for (const [name, payload] of files) {
      if (!name.startsWith(`${scope}/`)) continue;

      const id = name.slice(scope.length + 1);

      listing.present.push(id);

      if (!known.includes(id)) listing.files.push({ id, payload });
    }

    return listing;
  },
  remove: async (scope, ids) => {
    for (const id of ids) files.delete(`${scope}/${id}`);
  },
};

const scopes = {};
const macClock = new Clock("mac", null, () => NOW);

async function macSync() {
  for (const [scope, entries] of Object.entries(computerRecords.scopes)) {
    const values = new Map(Object.entries(entries));
    const prefixes = [...new Set([...values.keys()].map((key) => key.slice(0, key.indexOf(":") + 1)))];

    await syncScope({
      scope,
      state: (scopes[scope] ??= emptyScope()),
      transport,
      clock: macClock,
      device: "mac",
      now: () => NOW,
      adapters: prefixes.map((prefix) => ({
        prefix,
        extract: () => ({ values: new Map([...values].filter(([key]) => key.startsWith(prefix))), ignore: (key) => !values.has(key) }),
        apply: () => true,
      })),
    });
  }
}

let data = initialBrowserData({ ...createTab("phone-tab", NOW), url: "https://phone.example/", title: "On the phone" });

data = reduceBrowserData(data, { type: "visit", spaceId: "personal", url: "https://phone.example/", title: "On the phone", favicon: null, now: NOW - 1000 });

const doc = newDoc("phone");

const cycle = () =>
  runCycle(doc, {
    transport,
    deviceName: () => "Krish's iPhone",
    data: () => data,
    ready: () => true,
    dispatch: (action) => void (data = reduceBrowserData(data, action)),
    barTitle: () => "Bookmarks bar",
    historyLimit: HISTORY_LIMIT,
    save: async () => undefined,
    newSyncId: () => "phone-space",
    now: () => NOW,
  });

await macSync();

await cycle();

await cycle();

data = reduceBrowserData(data, { type: "pin-site", tabId: "phone-tab", pinId: "phone-pin", kind: "essential" });

await cycle();

await macSync();

const seen = Object.fromEntries(Object.entries(scopes).map(([scope, state]) => [scope, Object.fromEntries(visible(state, ""))]));

writeFileSync(
  join(here, "../fixtures/phone-sync.json"),
  `${JSON.stringify(
    {
      phone: {
        spaces: data.spaces,
        bookmarks: data.bookmarks,
        history: data.history,
        pinnedSites: data.pinnedSites,
        folders: data.folders,
        links: doc.spaces,
        profile: doc.profile,
      },
      computerSees: seen,
    },
    null,
    1,
  )}\n`,
);
