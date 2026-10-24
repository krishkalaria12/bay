import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// With several windows, only the coordinator writes the browser store. Window code reads the projection
// (store/read.ts) and dispatches commands (runtime/commands.ts). These modules may still import the writable
// singleton, each for the reason given; anything new must use the read and command APIs instead.
const ALLOWED = {
  // The legacy single-window entry and its shared helpers.
  "main.tsx": "legacy entry",
  "runtime/commands.ts": "local command executor for the legacy entry",
  "store/read.ts": "local read source for the legacy entry",
  "lib/devHarness.ts": "development only",
  // Coordinator-owned services (runtime/coordinatorEntry.ts, runtime/services.ts).
  "runtime/coordinatorEntry.ts": "the coordinator's authority store",
  "lib/native.ts": "coordinator native sync",
  "lib/persist.ts": "coordinator persistence",
  "lib/history.ts": "coordinator history service",
  "lib/bookmarks.ts": "coordinator bookmark service",
  "lib/favicons.ts": "coordinator favicon service",
  "lib/profileData.ts": "coordinator profile data service",
  "live/index.ts": "coordinator Live services",
  "live/engine.ts": "coordinator Live services",
  "live/alerts.ts": "coordinator meeting alerts",
  "live/meetingGroups.ts": "coordinator meeting groups",
  "telemetry/usage.ts": "coordinator telemetry",
  "components/extensions/searchEngines.ts": "store parameter defaults to the legacy singleton",
  // Window modules whose writes run only without the shared runtime (pageFactsInCoordinator).
  "components/ContentCard.tsx": "legacy page facts",
  "components/extensions/bridge.ts": "legacy page adoption",
  "components/layout/openFromPage.ts": "legacy page adoption",
  "components/layout/splitActions.ts": "legacy page adoption",
  "lib/chromeTabs.ts": "legacy tab strip mirror",
};

const root = fileURLToPath(new URL("..", import.meta.url));
function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}
const writable = /import\s*\{[^}]*\buseBrowser\b[^}]*\}\s*from\s*"(?:\.{1,2}\/)+(?:store\/)?browser"/;

test("only coordinator services and legacy-guarded modules import the writable browser store", () => {
  const found = [];
  for (const path of sources(root)) {
    const file = relative(root, path).split(sep).join("/"); // Windows paths use backslashes
    if (file.startsWith("store/") && file !== "store/read.ts" && file !== "store/hooks.ts") continue; // the store itself
    if (writable.test(readFileSync(path, "utf8"))) found.push(file);
  }
  assert.deepEqual(found.sort(), Object.keys(ALLOWED).sort());
});
