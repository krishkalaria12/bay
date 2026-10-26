// Native Phase 2 Undo acceptance, using an isolated Debug profile and local pages only.
// node apps/browser/scripts/phase2-undo-test.mjs <Debug Bay.app>
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg] = process.argv.slice(2);
if (!appArg) throw new Error("usage: phase2-undo-test.mjs <Debug Bay.app>");
const scratch = mkdtempSync(join(tmpdir(), "bay-phase2-undo-"));
const report = reporter(join(scratch, "undo.log"), { name: "phase2-undo" });
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end('<!doctype html><title>Undo fixture</title><input value="Original draft"><p>Plain page</p>');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
let app;
const run = (body) => app.eval(body);
const undo = () => run('return nn.shell.devKeyEquivalent("w1", {key:"z", keyCode:6, modifiers:["command"], asKey:true})');
const until = async (description, body) => {
  for (const end = Date.now() + 10000; Date.now() < end; await sleep(100)) if (await run(body)) return;
  throw new Error(`timed out: ${description}`);
};
try {
  app = await launch(resolve(appArg), {
    data: join(scratch, "data"),
    onboarded: true,
    session: session({
      settings: { launchTab: "lastTab", cmdClickCreatesTabGroup: false },
      windows: [{ id: "w1", activeTabIds: { default: "a" }, tabIds: ["a", "b", "c"] }],
      tabs: ["a", "b", "c"].map((id) => ({ id, title: id, url: `${base}/${id}` })),
    }),
  });
  await run(`nn.developer.setDeveloperMode(${JSON.stringify(base)}, false); return true`);
  await until("page loaded", 'return !!nn.webviews.get("a")');
  await sleep(1000);
  await report.check("native Cmd+Z restores every cleared tab at its original position", async () => {
    await run('nn.store.getState().cleanUpTabs("w1",{inactiveForMs:0}); return true');
    await until("clear", "return !nn.store.getState().tabs.b && !nn.store.getState().tabs.c");
    await undo();
    await until("clear undone", "return !!nn.store.getState().tabs.b && !!nn.store.getState().tabs.c");
    assert.deepEqual(await run("return nn.store.getState().tabLists.default"), ["a", "b", "c"]);
  });
  await report.check("native Cmd+Z undoes pin, rename, icon, and theme in order", async () => {
    await run(
      'const s=nn.store.getState(); s.pinRows(["b"],true); s.updateTab("b",{customTitle:"Renamed"}); s.updateTab("b",{customIcon:"📚"}); s.updateSpace("default",{theme:{colors:["#123456"],intensity:0.5,grain:0}}); return true',
    );
    for (let i = 0; i < 4; i++) {
      await undo();
      await sleep(180);
    }
    const result = await run(
      "const s=nn.store.getState(); return {pin:!!s.tabs.b.pinnedRow,name:s.tabs.b.customTitle,icon:s.tabs.b.customIcon,color:s.spaces.default.theme?.colors[0]}",
    );
    assert.deepEqual({ pin: result.pin, name: result.name, icon: result.icon }, { pin: false, name: null, icon: null });
    assert.notEqual(result.color, "#123456");
  });
  await report.check("web input Undo edits the draft and leaves sidebar history untouched", async () => {
    await run('nn.store.getState().updateTab("b",{customTitle:"Sidebar edit"}); return nn.webviews.get("a").focus()');
    const page = await app.page("/a");
    try {
      assert.equal(
        await page.eval(
          '(()=>{const f=document.querySelector("input"); f.focus(); f.select(); document.execCommand("insertText",false,"Edited draft"); return f.value})()',
        ),
        "Edited draft",
      );
      const count = await run("return nn.store.getState().sidebarUndo.w1.length");
      await run('return nn.shell.devKeyEquivalent("w1", {key:"z",keyCode:6,modifiers:["command"],focus:"page",asKey:true})');
      await sleep(350);
      assert.equal(await page.eval('document.querySelector("input").value'), "Original draft");
      assert.equal(await run("return nn.store.getState().sidebarUndo.w1.length"), count);
    } finally {
      page.close();
    }
  });
  await report.check("native close from a plain page can be undone", async () => {
    const page = await app.page("/a");
    try {
      await page.eval("document.activeElement.blur(); true");
    } finally {
      page.close();
    }
    await run('nn.store.getState().activate("b","w1"); return true');
    await until("b mounted", 'return !!nn.webviews.get("b")');
    await run('return nn.webviews.get("b").focus()');
    await run('nn.runCommand({command:"closeTab",arg:null,windowId:"w1"}); return true');
    await until("b closed", "return !nn.store.getState().tabs.b");
    await undo();
    await until("b restored", "return !!nn.store.getState().tabs.b");
    assert.equal(await run("return nn.store.getState().windows.w1.activeTabIds.default"), "b");
  });
} finally {
  await app?.quit();
  server.close();
  writeFileSync(join(scratch, "results.json"), JSON.stringify({ failures: report.failed, scratch }, null, 2));
}
process.exitCode = report.summary() ? 0 : 1;
console.log(`Evidence: ${scratch}`);
