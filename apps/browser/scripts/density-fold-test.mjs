// Native sidebar acceptance: density controls, click-to-fold and persisted folding.
// node apps/browser/scripts/density-fold-test.mjs <Debug Bay.app> [--keep-data]
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appPath = args.find((a) => !a.startsWith("--"));
if (!appPath) throw new Error("Provide the Debug Bay.app path");
const data = mkdtempSync(join(tmpdir(), "bay-density-fold-"));
let app;
try {
  app = await launch(resolve(appPath), {
    data,
    session: session({
      spaces: [{ id: "default", name: "Personal with a long name", icon: "🏠" }],
      settings: { density: "comfortable", launchTab: "lastTab", addressBar: "sidebar" },
      windows: [{ id: "w1", activeTabIds: { default: "today" }, tabIds: ["essential", "pin", "folder", "today"] }],
      tabs: [
        { id: "essential", pinned: true, url: "data:text/html,<title>Essential</title>", title: "Essential" },
        { id: "pin", pinnedRow: true, url: "data:text/html,<title>Pinned tab</title>", title: "Pinned tab with a long title to fade" },
        { id: "folder", pinnedRow: true, folderId: "work", url: "data:text/html,<title>Folder tab</title>", title: "Folder tab with a long title to fade" },
        { id: "today", url: "data:text/html,<title>Today</title><h1>Today stays visible</h1>", title: "Today's tab with a long title to fade" },
      ],
      pinnedFolders: [{ id: "work", spaceId: "default", name: "A folder with a long name", icon: null, collapsed: false, createdAt: 0 }],
    }),
  });
  const native = `const C = globalThis.expo.modules.BayCEF; const win = () => C.chromeWindows().then(windows => windows.find(w => w.hasRoot).window);`;
  const shot = (name) => app.eval(`return nn.shell.devSnapshotWindow("w1", ${JSON.stringify(join(data, name + ".png"))});`);
  await sleep(1000);
  assert.equal(await shot("comfortable"), true);
  await app.eval(`return globalThis.sidebarDrag.begin("t:pin", 80, 180, []);`);
  assert.equal(await app.eval(`return globalThis.sidebarDrag.active;`), true);
  assert.equal(await app.eval(`return globalThis.sidebarDrag.items.get("t:pin").frame.h;`), 36);
  await app.eval(`nn.store.getState().updateSettings({ density: "compact" }); return true;`);
  await sleep(500);
  assert.equal(await app.eval(`return globalThis.sidebarDrag.active;`), false, "density change cancels frames captured at the old size");
  await app.eval(`return globalThis.sidebarDrag.begin("t:pin", 80, 175, []);`);
  assert.equal(await app.eval(`return globalThis.sidebarDrag.items.get("t:pin").frame.h;`), 30);
  await app.eval(`globalThis.sidebarDrag.end(false); return true;`);
  await sleep(500);
  assert.equal(await shot("compact"), true);
  // The title begins after the address field and Essential tile; click its name, away from its menu.
  const hit = await app.eval(`${native} return win().then(n => C.devWindow(n, "click:85,133"));`);
  await sleep(500);
  const folded = await app.eval(`return !!nn.store.getState().spaces.default.folded;`);
  assert.equal(folded, true, `title click folds the space, hit: ${hit}`);
  assert.equal(await app.eval(`return nn.store.getState().windows.w1.activeTabIds.default;`), "today");
  assert.equal(await app.eval(`return globalThis.sidebarDrag.items.has("t:pin");`), false);
  assert.equal(await app.eval(`return globalThis.sidebarDrag.items.has("f:work");`), false);
  assert.equal(await app.eval(`return globalThis.sidebarDrag.items.has("t:today");`), true);
  assert.equal(await app.eval(`return globalThis.sidebarDrag.items.has("t:essential");`), true);
  assert.equal(await shot("folded"), true);
  await sleep(1000);
  await app.quit();
  app = await launch(resolve(appPath), { data });
  assert.equal(await app.eval(`return !!nn.store.getState().spaces.default.folded;`), true);
  assert.equal(await app.eval(`return nn.store.getState().settings.density;`), "compact");
  assert.equal(await shot("relaunched"), true);
  console.log(`PASS: density switches, title click folds, today remains active, fold and density survive relaunch. Evidence: ${data}`);
} finally {
  await app?.quit();
  if (!args.includes("--keep-data")) rmSync(data, { recursive: true, force: true });
}
