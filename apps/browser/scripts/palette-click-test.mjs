// Native acceptance: one click selects a tab through an open palette; page clicks still dismiss it.
// node apps/browser/scripts/palette-click-test.mjs <Debug Bay.app>
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appPath] = process.argv.slice(2);
if (!appPath) throw new Error("Provide the Debug Bay.app path");
const scratch = mkdtempSync(join(tmpdir(), "bay-palette-click-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "palette-click-test.log"), { name: "palette-click-test" });
let app;
try {
  app = await launch(resolve(appPath), {
    data,
    session: session({
      settings: { launchTab: "lastTab", addressBar: "sidebar" },
      windows: [{ id: "w1", tabIds: ["essential", "pin", "today"], activeTabIds: { default: "today" } }],
      tabs: [
        { id: "essential", pinned: true, url: "data:text/html,<title>Essential</title>", title: "Essential" },
        { id: "pin", pinnedRow: true, url: "data:text/html,<title>Pinned</title>", title: "Pinned" },
        { id: "today", url: "data:text/html,<title>Today</title>", title: "Today" },
      ],
    }),
  });
  const run = (body) => app.eval(body);
  const native = `const C = globalThis.expo.modules.BayCEF;
    const win = () => C.chromeWindows().then(ws => ws.find(w => w.hasRoot).window);`;
  const click = (x, y) => run(`${native} return win().then(n => C.devWindow(n, "click:${x},${y}"));`);
  const state = () =>
    run(`const s = nn.store.getState(); return {
    active: s.windows.w1.activeTabIds.default, open: !!s.windowUi.w1?.panel.open };`);
  const open = async (mode) => {
    await run(`const s = nn.store.getState(); s.activate("today", "w1");
      s.${mode === "newTab" ? "openNewTabPanel" : "openPanel"}("w1"); return true;`);
    await sleep(350);
    assert.deepEqual(await state(), { active: "today", open: true });
  };

  for (const position of ["left", "right"]) {
    await run(`nn.store.getState().updateSettings({ sidebarPosition: "${position}", sidebarWidth: 280 }); return true;`);
    await sleep(500);
    for (const mode of ["navigate", "newTab"]) {
      for (const tab of ["essential", "pin", "today"]) {
        await rep.check(`${position} sidebar, ${mode}, ${tab}`, async () => {
          await open(mode);
          const point = await run(`const item = globalThis.sidebarDrag.items.get("t:${tab}");
            if (!item?.view) throw new Error("missing row ${tab}");
            return new Promise(resolve => item.view.measureInWindow((x, y, w, h) => resolve([x + 24, y + h / 2])));`);
          const hit = await click(...point);
          await sleep(350);
          assert.deepEqual(await state(), { active: tab, open: false }, `one click on ${tab}, hit: ${hit}`);
        });
      }
    }
  }

  await rep.check("page click dismisses without switching tabs", async () => {
    await open("navigate");
    await click(640, 750);
    await sleep(350);
    assert.deepEqual(await state(), { active: "today", open: false });
  });

  await run(`nn.store.getState().updateSettings({ tabLayout: "top" }); return true;`);
  await sleep(500);
  for (const mode of ["navigate", "newTab"]) {
    await rep.check(`top strip, ${mode}, essential`, async () => {
      await open(mode);
      // The first 34pt dock cell starts after the 78pt window buttons and 8pt gap.
      const hit = await click(103, 21);
      await sleep(350);
      assert.deepEqual(await state(), { active: "essential", open: false }, `one click on the dock, hit: ${hit}`);
    });
  }

  await rep.check("hidden sidebar leaves its former area available to dismiss", async () => {
    await run(`const s = nn.store.getState(); s.updateSettings({ tabLayout: "sidebar", sidebarPosition: "left" });
      s.toggleSidebar("w1"); return true;`);
    await sleep(500);
    await open("navigate");
    await click(40, 700);
    await sleep(350);
    assert.deepEqual(await state(), { active: "today", open: false });
  });
} catch (error) {
  rep.record("setup", { error });
} finally {
  await app?.quit();
  rmSync(data, { recursive: true, force: true });
}
process.exit(rep.summary() ? 0 : 1);
