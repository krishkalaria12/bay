// pnpm --filter @bay/browser test:folders <Debug Bay.app> [scratch directory]
// Evidence and reusable fake session data stay in scratch; the test quits only its own isolated instance.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, sleep } from "../../../scripts/lib/instance.mjs";
import { nestedFoldersFixture } from "./fixtures/nested-folders.mjs";

const [appArg, scratchArg] = process.argv.slice(2);
if (!appArg) throw new Error("usage: nested-folders-test.mjs <Debug Bay.app> [scratch directory]");
const appPath = resolve(appArg);
const scratch = scratchArg ? resolve(scratchArg) : mkdtempSync(join(tmpdir(), "bay-nested-folders-"));
mkdirSync(scratch, { recursive: true });
const data = join(scratch, "data");
const fixture = nestedFoldersFixture();
writeFileSync(join(scratch, "fixture.json"), JSON.stringify(fixture, null, 2));
const report = reporter(join(scratch, "nested-folders.log"), { name: "nested-folders" });
const native = `const C = globalThis.expo.modules.BayCEF; const win = () => C.chromeWindows().then(ws => ws.find(w => w.hasRoot).window);`;
let app;
const run = (body) => app.eval(body);
const until = async (description, body) => {
  for (const end = Date.now() + 12000; Date.now() < end; await sleep(100)) {
    const result = await run(body);
    if (result) return result;
  }
  throw new Error(`timed out waiting for ${description}`);
};
const shot = (name) => run(`return nn.shell.devSnapshotWindow("w1", ${JSON.stringify(join(scratch, name + ".png"))})`);
const drag = async (source, target, { root = false } = {}) => {
  const result = await run(`
    const d = globalThis.sidebarDrag;
    const measure = v => new Promise(resolve => v.measureInWindow((x,y,w,h) => resolve({x,y,w,h})));
    return Promise.all([measure(d.items.get(${JSON.stringify(source)}).header ?? d.items.get(${JSON.stringify(source)}).view),
      measure(d.items.get(${JSON.stringify(target)}).header ?? d.items.get(${JSON.stringify(target)}).view)]).then(([a,b]) =>
        d.begin(${JSON.stringify(source)}, a.x + 20, a.y + a.h/2, []).then(() => {
        d.move(${root ? "b.x - 4" : "b.x + 30"}, ${root ? "b.y + 2" : "b.y + b.h/2"});
        const drop = d.drop;
        d.end(true);
        return { drop, source: a, target: b };
      }));`);
  await sleep(650);
  return result;
};

try {
  app = await launch(appPath, { data, session: fixture, onboarded: true });
  await until("recursive folder rows", 'return !!globalThis.sidebarDrag?.items.has("t:deep")');
  await report.check("five levels render once, including empty subfolders", async () => {
    const tree = await run(`const s = nn.store.getState(); return {
      root: nn.folders.entries.sidebarEntries(s,"w1").pinned,
      projects: nn.folders.entries.folderEntries(s,"projects"),
      depths: ["projects","designs","research","archive","level5"].map(id => nn.folders.model.folderDepth(s,id)),
      deep: nn.folders.geometry.rowSpan(s,"w1","default","deep",false),
      rows: [...globalThis.sidebarDrag.items.keys()]
    }`);
    assert.deepEqual(tree.depths, [1, 2, 3, 4, 5]);
    assert.deepEqual(new Set(tree.root), new Set(["f:projects", "f:reading", "t:loose"]));
    assert.ok(tree.projects.includes("f:designs") && tree.projects.includes("f:empty"));
    assert.ok(tree.deep && tree.deep.top > 0);
    assert.equal(tree.rows.filter((k) => k === "t:deep").length, 1);
    assert.equal(await shot("expanded"), true);
    return tree;
  });
  await report.check("Move to Folder menus expose a tree with destinations at every level", async () => {
    const menu = await run('return nn.menus.moveToFolderItems("w1", undefined)');
    const projects = menu.find((item) => item.id === "pfolderBranch:projects");
    const designs = projects.children.find((item) => item.id === "pfolderBranch:designs");
    const research = designs.children.find((item) => item.id === "pfolderBranch:research");
    const archive = research.children.find((item) => item.id === "pfolderBranch:archive");
    assert.equal(projects.children[0].id, "pfolder:projects");
    assert.equal(archive.children.find((item) => item.id === "pfolder:level5").title, "Level five");
    assert.ok(projects.children.some((item) => item.id === "pfolder:empty"));
    return menu;
  });
  await report.check("native folder click folds descendants and keeps active descendant visible", async () => {
    await run('nn.store.getState().activate("deep","w1"); return true');
    const hit = await run(`${native}
      const item = globalThis.sidebarDrag.items.get("f:projects");
      return new Promise(resolve => item.header.measureInWindow((x,y,w,h) => win().then(n => C.devWindow(n,"click:"+(x+70)+","+(y+h/2))).then(resolve)));`);
    await until("collapsed root", "return nn.store.getState().pinnedFolders.projects.collapsed");
    await sleep(500);
    assert.equal(await run('return globalThis.sidebarDrag.items.has("f:designs")'), false);
    assert.equal(await run('return globalThis.sidebarDrag.items.has("t:deep")'), true);
    assert.equal(await shot("collapsed-active-descendant"), true);
    await run('nn.store.getState().updatePinnedFolder("projects",{collapsed:false}); nn.store.getState().activate("today","w1"); return true');
    await until("expanded root", 'return globalThis.sidebarDrag.items.has("f:designs")');
    await sleep(500);
    return { hit };
  });
  await report.check("empty folders drag before populated siblings and undo preserves mixed order", async () => {
    const before = await run('return nn.folders.entries.folderEntries(nn.store.getState(),"projects")');
    assert.deepEqual(before, ["t:overview", "f:designs", "t:summary", "f:empty"]);
    const moved = await drag("f:empty", "f:designs", { root: true });
    assert.equal(moved.drop.parentId, "projects");
    assert.deepEqual(await run('return nn.folders.entries.folderEntries(nn.store.getState(),"projects")'), ["t:overview", "f:empty", "f:designs", "t:summary"]);
    const filled = await drag("t:loose", "f:empty");
    assert.equal(filled.drop.placement?.folderId, "empty");
    assert.deepEqual(await run('return nn.folders.entries.folderEntries(nn.store.getState(),"projects")'), ["t:overview", "f:empty", "f:designs", "t:summary"]);
    assert.equal(await run("return nn.store.getState().undoPinnedFolderMove()"), true);
    await sleep(500);
    assert.equal(await run("return nn.store.getState().undoPinnedFolderMove()"), true);
    await sleep(500);
    assert.deepEqual(await run('return nn.folders.entries.folderEntries(nn.store.getState(),"projects")'), before);
    return moved;
  });
  await report.check("selected descendants hidden by collapse cannot become drop targets", async () => {
    await run('nn.store.getState().setSelection("w1",["overview","design"]); nn.store.getState().updatePinnedFolder("projects",{collapsed:true}); return true');
    await sleep(500);
    const result = await run(`const d=globalThis.sidebarDrag;
      const hidden=d.items.get("f:designs");
      if (!hidden) return {unmounted:true};
      const measure=v=>new Promise(resolve=>v.measureInWindow((x,y,w,h)=>resolve({x,y,w,h})));
      return Promise.all([measure(d.items.get("t:loose").view),measure(hidden.header)]).then(([a,b])=>
        d.begin("t:loose",a.x+20,a.y+a.h/2,[]).then(()=>{
          d.move(b.x+30,b.y+b.h/2); const drop=d.drop; d.end(false); return {drop,hidden:b};
        }));`);
    assert.notEqual(result.drop?.placement?.folderId, "designs");
    await run('nn.store.getState().setSelection("w1",[]); nn.store.getState().updatePinnedFolder("projects",{collapsed:false}); return true');
    await until("expanded selected tree", 'return globalThis.sidebarDrag.items.has("t:deep")');
    await sleep(500);
    return result;
  });
  await report.check("drag a tab into deepest folder, then out to its parent", async () => {
    const inside = await drag("t:loose", "f:level5");
    assert.equal(inside.drop.placement?.folderId, "level5");
    assert.equal(await run("return nn.store.getState().tabs.loose.folderId"), "level5");
    const outside = await drag("t:loose", "f:archive");
    assert.equal(outside.drop.placement?.folderId, "archive");
    assert.equal(await run("return nn.store.getState().tabs.loose.folderId"), "archive");
    return { inside, outside };
  });
  await report.check("native Cmd+Z undoes a tab move", async () => {
    const moved = await drag("t:loose", "f:level5");
    assert.equal(await run("return nn.store.getState().tabs.loose.folderId"), "level5");
    const key = await run(`${native} return win().then(n => C.devWindow(n, "keys:1048576:z:6"))`);
    await until("native Undo restored tab parent", 'return nn.store.getState().tabs.loose.folderId === "archive"');
    return { moved, key };
  });
  await report.check("AppKit mouse events drag a nested tab between levels", async () => {
    const hit = await run(`${native}
      const d=globalThis.sidebarDrag;
      const measure=v=>new Promise(resolve=>v.measureInWindow((x,y,w,h)=>resolve({x,y,w,h})));
      return Promise.all([measure(d.items.get("t:loose").view),measure(d.items.get("f:projects").header)]).then(([a,b])=>
        win().then(n=>C.devWindow(n,"drag:"+(a.x+60)+","+(a.y+a.h/2)+";"+(a.x+75)+","+(a.y+a.h/2)+";"+(b.x+70)+","+(b.y+b.h/2))));`);
    await until("native mouse drag changed tab parent", 'return nn.store.getState().tabs.loose.folderId === "projects"');
    await sleep(500);
    const key = await run(`${native} return win().then(n => C.devWindow(n, "keys:1048576:z:6"))`);
    await until("native Undo restored mouse drag", 'return nn.store.getState().tabs.loose.folderId === "archive"');
    await sleep(500);
    return { hit, key };
  });
  await report.check("drag a folder subtree between levels and undo", async () => {
    const inside = await drag("f:designs", "f:reading");
    assert.equal(inside.drop.type, "folder");
    assert.equal(await run("return nn.store.getState().pinnedFolders.designs.parentId"), "reading");
    assert.equal(await run("return nn.store.getState().pinnedFolders.research.parentId"), "designs");
    const key = await run(`${native} return win().then(n => C.devWindow(n, "keys:1048576:z:6"))`);
    await until("native Undo restored folder parent", 'return nn.store.getState().pinnedFolders.designs.parentId === "projects"');
    assert.equal(await run("return nn.store.getState().pinnedFolders.designs.parentId"), "projects");
    await sleep(600);
    const outside = await drag("f:designs", "f:reading", { root: true });
    assert.equal(outside.drop.type, "folder");
    assert.equal(await run("return nn.store.getState().pinnedFolders.designs.parentId ?? null"), null);
    assert.equal(await run("return nn.store.getState().undoPinnedFolderMove()"), true);
    await sleep(600);
    return { inside, outside, key };
  });
  await report.check("page text keeps its own Undo after a sidebar move", async () => {
    const moved = await drag("t:loose", "f:level5");
    const count = await run("return nn.store.getState().folderMoveUndo.length");
    const page = await app.page("data:text/html,");
    try {
      assert.equal(
        await page.eval(
          `(() => { const input=document.querySelector("input"); input.focus(); input.select(); document.execCommand("insertText",false,"edited draft"); return input.value; })()`,
        ),
        "edited draft",
      );
      const key = await run('return nn.shell.devKeyEquivalent("w1",{key:"z",keyCode:6,modifiers:["command"],focus:"page",asKey:true})');
      await sleep(400);
      assert.equal(await page.eval('document.querySelector("input").value'), "Try editing, then Undo");
      assert.equal(await run("return nn.store.getState().folderMoveUndo.length"), count);
      assert.equal(await run("return nn.store.getState().tabs.loose.folderId"), "level5");
      assert.equal(await run("return nn.store.getState().undoPinnedFolderMove()"), true);
      await sleep(500);
      return { moved, key };
    } finally {
      page.close();
    }
  });
  await report.check("depth and cycle guards reject moves without losing any tab", async () => {
    const result = await run(`const s=nn.store.getState(); const before=Object.keys(s.tabs);
      const extra=s.newPinnedFolder("w1",{name:"Too deep",parentId:"level5"});
      s.movePinnedFolder("projects",null,"research");
      s.movePinnedFolder("reading",null,"level5");
      const after=nn.store.getState(); return {extra,parent:after.pinnedFolders.projects.parentId??null,reading:after.pinnedFolders.reading.parentId??null,before,after:Object.keys(after.tabs)};`);
    assert.equal(result.extra, "");
    assert.equal(result.parent, null);
    assert.equal(result.reading, null);
    assert.deepEqual(result.after, result.before);
    return result;
  });
  await report.check("folder structure and tab moves survive Debug app restart", async () => {
    await until(
      "saved nested state",
      `return JSON.parse(nn.shell.readDocument("session.json")).pinnedFolders.find(f=>f.id==="level5")?.parentId === "archive"`,
    );
    await sleep(800);
    const saved = JSON.parse(readFileSync(join(data, "session.json"), "utf8"));
    assert.equal(saved.tabs.find((t) => t.id === "loose").folderId, "archive");
    await app.quit();
    app = await launch(appPath, { data });
    await until("restored folder rows", 'return !!globalThis.sidebarDrag?.items.has("t:deep")');
    assert.equal(await run("return nn.store.getState().pinnedFolders.level5.parentId"), "archive");
    assert.equal(await run("return nn.store.getState().tabs.loose.folderId"), "archive");
    assert.equal(await shot("restored"), true);
  });
} finally {
  await app?.quit();
  writeFileSync(join(scratch, "results.json"), JSON.stringify({ passed: !report.failed.length, failures: report.failed, scratch }, null, 2));
}
process.exitCode = report.summary() ? 0 : 1;
console.log(`Fake data and screenshots: ${scratch}`);
