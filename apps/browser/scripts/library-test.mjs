// Local Library/Easels acceptance in a disposable native app instance. Exports written to Downloads are removed.
// node apps/browser/scripts/library-test.mjs <Debug Bay.app> [cdpPort]
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";
const [appArg, port] = process.argv.slice(2);
if (!appArg) throw new Error("usage: node library-test.mjs <Debug Bay.app> [cdpPort]");
const scratch = mkdtempSync(join(tmpdir(), "bay-library-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "library-test.log"), { name: "library-test" });
const exported = [];
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><title>Easel fixture</title><style>body{margin:0;height:2400px;background:#fff;font:24px system-ui}#clip{position:absolute;left:100px;top:250px;width:320px;height:180px;background:#246e97;color:white;padding:0;display:grid;place-items:center}button{font:inherit}</style><div id=clip><button onclick="this.textContent='Clicked live'">Live source</button></div>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
let app;
let board;
let boardTab;
let media;
const nn = (body) => app.eval(body, { timeout: 30000 });
async function until(label, body, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await nn(body);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
const canvas = () => `nn.library.canvases.get(${JSON.stringify(boardTab)})`;
const items = () => nn(`return nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}].items;`);
try {
  app = await launch(resolve(appArg), {
    data,
    port,
    session: session({
      settings: { launchTab: "lastTab" },
      tabs: [{ id: "t1", url, title: "Easel fixture" }],
      windows: [{ id: "w1", tabIds: ["t1"], activeTabIds: { default: "t1" } }],
    }),
  });
  const page = await app.page(url);
  await sleep(800);
  await rep.check("Capture result retains a durable source-linked Library image", async () => {
    await nn('nn.capture.startCapture("t1"); return true;');
    await until("selection", 'return nn.capture.useCaptures.getState().sessions.t1?.phase === "selecting";');
    await nn(
      'nn.capture.onCaptureMessage("t1", { type:"capture", x:100,y:250,left:100,top:250,width:320,height:180,viewportWidth:1000,viewportHeight:800 }); return true;',
    );
    await until("capture", 'return nn.capture.useCaptures.getState().sessions.t1?.phase === "ready";');
    await nn('return nn.capture.captureToLibrary("t1");');
    media = await nn("return Object.values(nn.library.state.useLibrary.getState().media)[0];");
    assert.ok(media.path.includes("Library Media"));
    assert.ok(existsSync(media.path));
    assert.deepEqual(media.source.clip, [100, 250, 320, 180]);
    assert.equal(media.source.profileId, "");
    assert.equal(await nn("return nn.capture.useCaptures.getState().sessions.t1 ?? null;"), null);
    return media.path;
  });
  await rep.check("New Easel opens as its own pinned row and accepts Library captures", async () => {
    board = await nn('return nn.library.actions.newEasel("w1");');
    boardTab = await until(
      "pinned Easel tab",
      `const s=nn.store.getState(); return Object.values(s.tabs).find(t=>t.url===nn.library.actions.easelUrl(${JSON.stringify(board)}))?.id;`,
    );
    assert.equal(await nn(`return nn.store.getState().tabs[${JSON.stringify(boardTab)}].pinnedRow;`), true);
    await until("native canvas", `return !!${canvas()};`);
    const added = await nn(`return nn.library.state.addMediaToEasel(${JSON.stringify(board)}, ${JSON.stringify(media)});`);
    assert.equal(added, true);
    await sleep(250);
    assert.equal((await items()).length, 1);
    return { board, boardTab };
  });
  await rep.check("Native text, links, images, duplicate, delete and undo persist", async () => {
    await nn(`return ${canvas()}.addLink("mailto:person@example.com", "Unsupported link");`);
    assert.equal((await items()).length, 1, "unsupported links cannot poison later persistence");
    await nn(`return ${canvas()}.addText(${JSON.stringify('A saved idea <script> & "quote"')});`);
    await nn(`return ${canvas()}.addLink("https://example.com/?q=one&two=three", "Reference page");`);
    await nn(`return ${canvas()}.addImages([${JSON.stringify(media.path)}]);`);
    await until("four items", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}].items.length===4;`);
    await nn(`return ${canvas()}.duplicateSelection();`);
    await until("duplicate", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}].items.length===5;`);
    await nn(`return ${canvas()}.deleteSelection();`);
    await until("delete", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}].items.length===4;`);
    await nn(`return ${canvas()}.undo();`);
    await until("undo", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}].items.length===5;`);
    await nn(`return ${canvas()}.redo();`);
    await until("redo", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}].items.length===4;`);
    return (await items()).map((i) => i.kind);
  });
  await rep.check("PNG and standalone HTML exports contain the board and escaped source links", async () => {
    await nn(`return ${canvas()}.fit();`);
    const image = await nn(`return ${canvas()}.export();`);
    assert.ok(image?.width > 100 && image.height > 50);
    assert.equal(readFileSync(image.path).subarray(1, 4).toString(), "PNG");
    await nn(`nn.library.state.updateEasel(${JSON.stringify(board)},{title:'References <script>alert(1)</script>'}); return true;`);
    const htmlPath = await nn(`return nn.shell.exportEaselHTML(JSON.stringify(nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}]));`);
    exported.push(htmlPath);
    const html = readFileSync(htmlPath, "utf8");
    assert.ok(html.includes("data:image/png;base64,"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("https://example.com/?q=one&amp;two=three"));
    await nn(`return nn.shell.devSnapshotWindow("w1",${JSON.stringify(join(scratch, "easel.png"))});`);
    return { png: image, html: htmlPath };
  });
  await rep.check("A live capture mounts a real source-profile page and accepts clicks", async () => {
    await nn(
      `const state=nn.library.state; const d=state.useLibrary.getState().easels[${JSON.stringify(board)}]; state.updateEasel(d.id,{items:d.items.map((i,n)=>n===0?{...i,live:true}:i)}); return true;`,
    );
    await sleep(1200);
    const pages = (await app.targets()).filter((t) => t.type === "page" && t.url === url);
    assert.ok(pages.length >= 2, `only ${pages.length} source pages`);
    // The first source tab and live crop are separate Chromium browsers.
    const live = await app.page((t) => t.url === url && t.id !== page.target.id);
    await live.eval("document.querySelector('button').click()");
    assert.equal(await live.eval("document.querySelector('button').textContent"), "Clicked live");
    assert.ok(Math.abs((await live.eval("scrollY")) - 250) < 3);
    await live.close();
    await nn(
      `const d=nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}]; nn.library.state.updateEasel(d.id,{items:d.items.map(i=>({...i,live:false}))}); return true;`,
    );
    return { livePages: pages.length };
  });
  await rep.check("Library has no Chromium page and opening different Easels keeps distinct tabs", async () => {
    await nn('nn.library.actions.openLibrary("w1","easels"); return true;');
    await sleep(350);
    assert.ok(!(await app.targets()).some((t) => t.url.startsWith("chrome://library") || t.url.startsWith("chrome://easel")));
    await nn(`return nn.shell.devSnapshotWindow("w1",${JSON.stringify(join(scratch, "library.png"))});`);
    const next = await nn('return nn.library.actions.newEasel("w1");');
    assert.notEqual(next, board);
    assert.ok(await nn(`return Object.values(nn.store.getState().tabs).filter(t=>t.url.startsWith('bay://easel/')).length >= 2;`));
    await nn(`nn.store.getState().removeTab(${JSON.stringify(boardTab)}); return true;`);
    assert.ok(await nn(`return !!nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}];`));
    return "documents outlive their tabs";
  });
  await rep.check("A relaunch reloads Easels, media files and source metadata", async () => {
    await app.quit();
    app = await launch(resolve(appArg), { data, port });
    assert.equal(await nn(`return nn.library.state.useLibrary.getState().easels[${JSON.stringify(board)}].items.length;`), 4);
    assert.ok(existsSync(media.path));
    boardTab = await nn(`return nn.library.actions.openEasel(${JSON.stringify(board)},"w1");`);
    await until("reopened canvas", `return !!${canvas()};`);
    const image = await nn(`return ${canvas()}.export();`);
    assert.ok(image?.width > 100);
    return "reopened board exported after relaunch";
  });
  await rep.check("Tool keys reach the native canvas and synchronize its toolbar state", async () => {
    await nn(`return ${canvas()}.focus();`);
    for (const [key, tool] of [
      ["r", "rect"],
      ["p", "pen"],
      ["v", "select"],
    ]) {
      await nn(`return nn.shell.devTypeKeys("w1", ${JSON.stringify(key)}, 0);`);
      await until(`tool ${tool}`, `return nn.library.canvasStates.get(${JSON.stringify(boardTab)})?.tool===${JSON.stringify(tool)};`);
    }
    return "R/P/V selected rectangle/pen/select";
  });
  await rep.check("Deleting in another window cannot resurrect an earlier canvas snapshot", async () => {
    const shared = await nn('return nn.library.actions.newEasel("w1");');
    const tabA = await nn(`return Object.values(nn.store.getState().tabs).find(t=>t.url===nn.library.actions.easelUrl(${JSON.stringify(shared)})).id;`);
    await until("first shared canvas", `return !!nn.library.canvases.get(${JSON.stringify(tabA)});`);
    const w2 = await nn("return nn.actions.openWindow();");
    const tabB = await nn(`return nn.store.getState().newTab(${JSON.stringify(w2)},{url:nn.library.actions.easelUrl(${JSON.stringify(shared)})});`);
    await until("second shared canvas", `return !!nn.library.canvases.get(${JSON.stringify(tabB)});`);
    await nn(`return nn.library.canvases.get(${JSON.stringify(tabA)}).addText("Delete this");`);
    await until("shared item", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(shared)}].items.length===1;`);
    await sleep(150);
    await nn(`return nn.library.canvases.get(${JSON.stringify(tabB)}).focus();`);
    await nn(`return nn.library.canvases.get(${JSON.stringify(tabB)}).selectAll();`);
    await until("selected shared item", `return nn.library.canvasStates.get(${JSON.stringify(tabB)})?.selection.length===1;`);
    await nn(`return nn.library.canvases.get(${JSON.stringify(tabB)}).deleteSelection();`);
    await until("deleted across windows", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(shared)}].items.length===0;`);
    await sleep(150);
    await nn(`return nn.library.canvases.get(${JSON.stringify(tabA)}).addText("Keep only this");`);
    await until("new shared item", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(shared)}].items.length===1;`);
    const sharedItems = await nn(`return nn.library.state.useLibrary.getState().easels[${JSON.stringify(shared)}].items;`);
    assert.equal(sharedItems[0].text, "Keep only this");
    await nn(`nn.store.getState().closeWindow(${JSON.stringify(w2)}); nn.store.getState().activate(${JSON.stringify(boardTab)},"w1"); return true;`);
    return "foreign deletion accepted by both canvases";
  });
  await rep.check("Pasted URLs with spaces are normalized and later edits still save", async () => {
    const testId = await nn('return nn.library.actions.newEasel("w1");');
    const testTab = await nn(`return Object.values(nn.store.getState().tabs).find(t=>t.url===nn.library.actions.easelUrl(${JSON.stringify(testId)})).id;`);
    await until("URL normalization canvas", `return !!nn.library.canvases.get(${JSON.stringify(testTab)});`);
    await nn(`return nn.library.canvases.get(${JSON.stringify(testTab)}).addLink("https://example.com/a b", "Space URL");`);
    await nn(`return nn.library.canvases.get(${JSON.stringify(testTab)}).addText("Saved after URL");`);
    await until("normalized URL and text persisted", `return nn.library.state.useLibrary.getState().easels[${JSON.stringify(testId)}].items.length===2;`);
    const saved = await nn(`return nn.library.state.useLibrary.getState().easels[${JSON.stringify(testId)}].items;`);
    assert.equal(saved[0].url, "https://example.com/a%20b");
    assert.equal(saved[1].text, "Saved after URL");
    return "normalized URL and subsequent text persisted";
  });
  await rep.check("Private windows cannot save or reveal the regular Library", async () => {
    const before = await nn("return Object.keys(nn.library.state.useLibrary.getState().easels).length;");
    const privateWindow = await nn("return nn.actions.openWindow({incognito:true});");
    assert.equal(await nn(`return nn.library.actions.newEasel(${JSON.stringify(privateWindow)});`), null);
    assert.equal(await nn("return Object.keys(nn.library.state.useLibrary.getState().easels).length;"), before);
    return "private creation refused";
  });
} catch (error) {
  rep.record("setup", { error });
} finally {
  for (const path of exported) if (path) rmSync(path, { force: true });
  await app?.quit();
  server.close();
}
console.log(`Test data and screenshots: ${scratch}`);
process.exit(rep.summary() ? 0 : 1);
