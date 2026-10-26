// node apps/browser/scripts/sidebar-keyboard-test.mjs <Debug Bay.app> [evidence directory]
// Uses AppKit's posted key events, isolated data, and the development harness. Leaves screenshots and a log.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg, evidenceArg] = process.argv.slice(2);
if (!appArg) throw new Error("usage: sidebar-keyboard-test.mjs <Debug Bay.app> [evidence directory]");
const evidence = evidenceArg ? resolve(evidenceArg) : mkdtempSync(join(tmpdir(), "bay-sidebar-keyboard-"));
const report = reporter(join(evidence, "sidebar-keyboard.log"), { name: "sidebar-keyboard" });
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    '<!doctype html><title>Keyboard fixture</title><h1>Keyboard fixture</h1><input id="editor" value="page text"><div contenteditable>editable page</div>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let app;
const run = (body) => app.eval(body);
const until = async (description, body) => {
  for (const end = Date.now() + 10000; Date.now() < end; await sleep(80)) {
    const value = await run(body);
    if (value) return value;
  }
  throw new Error(`timed out: ${description}`);
};
const press = async (key, keyCode, modifiers = []) => {
  assert.equal(await run(`return globalThis.expo.modules.BayApp.devPostKey("w1", ${JSON.stringify(key)}, ${keyCode}, ${JSON.stringify(modifiers)})`), true);
  await sleep(350);
};
const focus = () => press("menu:.", 47, ["command"]);
const row = () => run("return nn.sidebarUi.getState().keyboard.w1");
const target = async (id) => {
  await focus();
  await press(String.fromCharCode(0xf729), 115);
  for (let i = 0; i < 180; i++) {
    if ((await row())?.rowId === id) return;
    await press(String.fromCharCode(0xf701), 125);
  }
  throw new Error(`could not navigate to ${id}`);
};
try {
  app = await launch(resolve(appArg), {
    data: join(evidence, "data"),
    onboarded: true,
    session: session({
      settings: { launchTab: "lastTab", newTabPosition: "bottom" },
      windows: [{ id: "w1", tabIds: ["page"], activeTabIds: { default: "page" } }],
      tabs: [{ id: "page", url: `${origin}/page`, title: "Page" }],
    }),
    ready: "return !!nn.sidebarKeyboard && !!globalThis.expo.modules.BayApp.devPostKey",
  });
  await run(`nn.developer.setDeveloperMode(${JSON.stringify(origin)}, false); return true`);
  const fixture = await run(`const s=nn.store.getState();
    const add=name=>s.newTab("w1",{url:${JSON.stringify(origin)}+"/"+name,background:true});
    const favorite=add("favorite"), pinned=add("pinned"), leaf=add("leaf");
    s.pinTabs([favorite],true); s.pinRows([pinned],true);
    const parent=s.newPinnedFolder("w1",{name:"Work"});
    const child=s.newPinnedFolder("w1",{name:"Research",parentId:parent,tabIds:[leaf]});
    const a=add("a"), b=add("b"), group=s.groupTabs([a,b],{name:"Group",pinned:true});
    const c=add("c"), d=add("d"), split=s.createSplit([c,d]);
    const loose=add("loose");
    for(let i=0;i<50;i++) add("tail"+i);
    nn.live.store.setLive({folders:{keyboardLive:{id:"keyboardLive",spaceId:"default",kind:"documents",name:"Keyboard documents",icon:null,collapsed:false,sources:["notion"],filters:{authored:true,reviewRequests:true},createdAt:1}},folderOrder:["keyboardLive"],items:{keyboardLive:[{id:"liveDocument",title:"Live document",url:${JSON.stringify(origin)}+"/live",source:"notion"}]},status:{keyboardLive:{state:"idle",lastFetch:Date.now(),error:null}}});
    s.activate("page","w1"); return {favorite,pinned,leaf,parent,child,group,a,b,c,d,split,loose};`);
  await sleep(1500);
  await report.check("Command-period claims sidebar and arrows leave selection and active page intact", async () => {
    await focus();
    assert.equal((await row()).active, true);
    await press(String.fromCharCode(0xf700), 126);
    const state = await run(
      "return {active:nn.store.getState().windows.w1.activeTabIds.default,selected:nn.store.getState().selection.w1??[],keyboard:nn.sidebarUi.getState().keyboard.w1}",
    );
    assert.equal(state.active, "page");
    assert.deepEqual(state.selected, []);
    assert.equal(state.keyboard.active, true);
    await run(`return nn.shell.devSnapshotWindow("w1", ${JSON.stringify(join(evidence, "focus-ring.png"))})`);
    return state;
  });
  await report.check("folder hierarchy is navigable through AppKit after actual row focus settles", async () => {
    await target(`f:${fixture.child}`);
    await press(String.fromCharCode(0xf703), 124);
    assert.equal((await row()).rowId, `t:${fixture.leaf}`);
    await press(String.fromCharCode(0xf702), 123);
    assert.equal((await row()).rowId, `f:${fixture.child}`);
    await press("\r", 36);
    assert.equal(await run(`return nn.store.getState().pinnedFolders[${JSON.stringify(fixture.child)}].collapsed`), true);
  });
  await report.check("group and live-folder disclosure and live item opening work from the keyboard", async () => {
    await target(`g:${fixture.group}`);
    await press("\r", 36);
    assert.equal(await run(`return nn.store.getState().groups[${JSON.stringify(fixture.group)}].collapsed`), true);
    await press(String.fromCharCode(0xf703), 124);
    assert.equal(await run(`return nn.store.getState().groups[${JSON.stringify(fixture.group)}].collapsed`), false);
    await target("livefolder|keyboardLive");
    await press("\r", 36);
    assert.equal(await run("return nn.live.store.live().folders.keyboardLive.collapsed"), true);
    await press(String.fromCharCode(0xf703), 124);
    await press(String.fromCharCode(0xf703), 124);
    assert.equal((await row()).rowId, "live|keyboardLive|liveDocument");
    await press("\r", 36);
    assert.equal(await run("const s=nn.store.getState(); return s.tabs[s.windows.w1.activeTabIds.default]?.liveItem?.itemId"), "liveDocument");
  });
  await report.check("Return opens favorite and split rows", async () => {
    for (const [id, tab] of [
      [`t:${fixture.favorite}`, fixture.favorite],
      [`s:${fixture.split}`, fixture.c],
    ]) {
      await target(id);
      await press("\r", 36);
      await until("row opens", `return nn.store.getState().windows.w1.activeTabIds.default===${JSON.stringify(tab)}`);
    }
  });
  await report.check("Space opens a peek, Escape returns to page", async () => {
    await target(`t:${fixture.pinned}`);
    await press(" ", 49);
    assert.ok(await run("return nn.store.getState().peeks.w1"));
    await focus();
    await press("\u001b", 53);
    assert.equal((await row()).active, false);
    assert.equal(await run("return !!nn.store.getState().peeks.w1"), false);
  });
  await report.check("Control-Command-R renames focused row and returns keyboard ownership", async () => {
    await target(`f:${fixture.parent}`);
    await press("menu:r", 15, ["control", "command"]);
    await until("rename field", 'return nn.sidebarUi.getState().renaming?.kind==="folder"');
    await press("\u001b", 53);
    await until("rename cancelled", "return !nn.sidebarUi.getState().renaming && nn.sidebarUi.getState().keyboard.w1.active");
  });
  await report.check("Backspace closes focused row and Command-Z restores it while sidebar owns keys", async () => {
    await run('nn.store.getState().activate("page","w1"); return true');
    // A pinned row only unloads, as Command-W does to it.
    await target(`t:${fixture.a}`);
    await press("\u007f", 51);
    assert.equal(await run(`return !!nn.store.getState().tabs[${JSON.stringify(fixture.a)}]`), true);
    await target(`t:${fixture.loose}`);
    await press("\u007f", 51);
    assert.equal(await run(`return !!nn.store.getState().tabs[${JSON.stringify(fixture.loose)}]`), false);
    await press("menu:z", 6, ["command"]);
    await until("sidebar undo", `return !!nn.store.getState().tabs[${JSON.stringify(fixture.loose)}]`);
    assert.equal((await row()).active, true);
  });
  await report.check("long-list navigation scrolls focused row into view", async () => {
    await focus();
    await press(String.fromCharCode(0xf72b), 119);
    const id = (await row()).rowId;
    assert.equal(id, await run('return nn.sidebarKeyboard.keyboardRows("w1").at(-1).id'));
    const frame = await run(
      `const row=globalThis.sidebarDrag.items.get(${JSON.stringify(id)}); return new Promise(resolve=>row.view.measureInWindow((x,y,width,height)=>resolve({x,y,width,height})));`,
    );
    assert.ok(frame.y >= 125 && frame.y + frame.height < 735, `focused row must be inside the visible list: ${JSON.stringify(frame)}`);
    await run(`return nn.shell.devSnapshotWindow("w1", ${JSON.stringify(join(evidence, "last-row.png"))})`);
    return { last: id, frame };
  });
  await report.check("page input retains focus and its text undo after unrelated sidebar edit", async () => {
    await press("\u001b", 53);
    await run('nn.store.getState().activate("page","w1"); return nn.webviews.get("page")?.focus()');
    const page = await app.page("/page");
    try {
      await page.eval('document.getElementById("editor").focus(); document.execCommand("insertText",false," changed"); true');
      const before = await page.eval('document.getElementById("editor").value');
      await run(`nn.store.getState().updatePinnedFolder(${JSON.stringify(fixture.parent)},{name:"Changed elsewhere"}); return true`);
      await sleep(250);
      await press("menu:z", 6, ["command"]);
      const after = await page.eval('document.getElementById("editor").value');
      assert.notEqual(after, before);
      assert.equal(await run(`return nn.store.getState().pinnedFolders[${JSON.stringify(fixture.parent)}].name`), "Changed elsewhere");
    } finally {
      page.close();
    }
  });
} finally {
  await app?.quit();
  server.close();
}
process.exitCode = report.summary() ? 0 : 1;
