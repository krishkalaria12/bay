// Run both search shortcut modes in an isolated Debug instance served by Metro.
// node apps/browser/scripts/bangs-test.mjs <Debug Bay.app>
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

if (!process.argv[2]) throw new Error("Pass a Debug Bay.app path; start Metro for this checkout first");
const data = mkdtempSync(join(tmpdir(), "bay-bangs-test-"));
const results = [];
const app = await launch(process.argv[2], {
  data,
  onboarded: true,
  session: session({ tabs: [{ id: "test", url: "about:blank", title: "Search test" }] }),
});
const run = (body) => app.eval(body);
const driver = 'nn.omnibox.get("w1:palette")';
const state = () =>
  run(
    "const s=nn.store.getState();return {tabs:Object.values(s.tabs).map(t=>({id:t.id,url:t.url})),active:s.windows.w1.activeTabIds.default,panel:s.windowUi.w1.panel.open,windows:s.windowOrder};",
  );
async function until(label, read) {
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(25)) {
    const value = await read();
    if (value) return value;
  }
  throw new Error(`Timed out: ${label}`);
}
async function open() {
  await run('nn.store.getState().closePanel("w1");return true;');
  await until("palette closed", () => run(`return !${driver};`));
  await run('nn.store.getState().openNewTabPanel("w1");return true;');
  await until("palette opened", () => run(`return !!${driver};`));
}
async function type(text) {
  await run(`${driver}.type(${JSON.stringify(text)});return true;`);
  await until("typed text committed", () => run(`return ${driver}?.state().typed === ${JSON.stringify(text)};`));
}
async function key(key, mods = {}) {
  await run(`${driver}.key(${JSON.stringify(key)},${JSON.stringify(mods)});return true;`);
}
// Exercise AppKit's field editor, which the JS driver's key() bypasses.
async function nativeTab(shift = false) {
  assert.equal(await run(`return globalThis.expo.modules.BayApp.devPostKey("w1", "\\t", 48, ${JSON.stringify(shift ? ["shift"] : [])});`), true);
}
const bar = () => run(`return ${driver}.state();`);
async function opened(url, before, background = false) {
  const s = await until(`opened ${url}`, async () => {
    const next = await state();
    return next.tabs.some((t) => !before.tabs.some((b) => b.id === t.id) && t.url === url) && next;
  });
  assert.equal(s.tabs.length, before.tabs.length + 1, "one submission opens exactly one tab");
  assert.equal(s.active === before.active, background, "foreground/background disposition");
}
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`PASS ${name}`);
}
async function holdCatalog() {
  await run(`nn.bangs.resetBangsForTests();nn.shell.writeDocument("bangs.txt", "");
    globalThis.bangTestRelease=undefined;
    nn.shell.writeDocument("bangs-state.json", JSON.stringify({checkedAt:Date.now()}));
    globalThis.bangTestPlatform.loadBundledBangs=()=>new Promise(resolve=>{
      globalThis.bangTestRelease=()=>globalThis.bangTestLoad().then(resolve);
    });return true;`);
}
const releaseCatalog = () => run("globalThis.bangTestRelease();globalThis.bangTestPlatform.loadBundledBangs=globalThis.bangTestLoad;return true;");

try {
  await run(`globalThis.bangTestRequests=[];
    globalThis.fetch=(url)=>{
      globalThis.bangTestRequests.push(String(url));
      return Promise.resolve(String(url).includes("/bangs.json")
        ? {status:304,headers:{get:()=>null}}
        : {ok:true,json:()=>Promise.resolve(["",[]])});
    };
    const id=[...globalThis.__r.getModules()].find(([,m])=>m.verboseName?.endsWith("omnibox/bangPlatform.ts"))[0];
    globalThis.bangTestPlatform=globalThis.__r(id);
    globalThis.bangTestLoad=globalThis.bangTestPlatform.loadBundledBangs;return true;`);

  await check("Arc is the default and does not load the bang catalog", async () => {
    assert.equal(await run("return nn.store.getState().settings.searchShortcutMode;"), "arc");
    await open();
    await type("!gh arc-mode");
    assert.equal((await bar()).items[0].engine, "Google");
    assert.equal(await run("return nn.bangs.bangStatus().loaded;"), false);
  });
  await check("Arc yt + Tab searches YouTube", async () => {
    await open();
    await type("yt");
    assert.equal((await bar()).tabScope.name, "YouTube");
    const beforeTab = await bar();
    await nativeTab(true);
    await until("Shift-Tab moves up without entering scope", async () => {
      const s = await bar();
      return !s.scope && s.selected === (beforeTab.selected + beforeTab.items.length - 1) % beforeTab.items.length;
    });
    await nativeTab();
    await until("YouTube scope", async () => (await bar()).scope?.name === "YouTube");
    await run('return nn.shell.devTypeKeys("w1", "funny cats", 25);');
    await until("query typed into the native field", async () => (await bar()).typed === "funny cats");
    assert.equal((await bar()).scopeColor, "#D90000");
    for (const appearance of ["light", "dark"]) {
      await run(`nn.store.getState().updateSettings({appearance:${JSON.stringify(appearance)}});return true;`);
      await sleep(200);
      assert.equal(await run(`return nn.shell.devSnapshotWindow("w1",${JSON.stringify(join(data, `scope-youtube-${appearance}.png`))});`), true);
    }
    const before = await state();
    await key("Enter");
    await opened("https://www.youtube.com/results?search_query=funny%20cats", before);
  });
  await check("custom shortcut configuration works in Arc mode", async () => {
    const result = await run('return nn.store.getState().addCustomEngine({name:"Work docs",keyword:"work",url:"https://docs.example/?q=%s"});');
    assert.ok(result.id);
    await open();
    await type("work");
    await nativeTab();
    await until("custom scope", async () => (await bar()).scope?.name === "Work docs");
    await type("release notes");
    const before = await state();
    await key("Enter");
    await opened("https://docs.example/?q=release%20notes", before);
  });
  await run('nn.store.getState().updateSettings({searchShortcutMode:"duckduckgo"});return true;');

  for (const [name, query, url, mods] of [
    [
      "cold Enter resolves GitHub and keeps the query away from engine suggestions",
      "!gh private-bang-query",
      "https://github.com/search?q=private-bang-query",
      {},
    ],
    ["cold Cmd-Enter opens a background bang tab", "!gh background", "https://github.com/search?q=background", { metaKey: true }],
    ["cold Option-Enter opens a foreground bang tab", "!gh foreground", "https://github.com/search?q=foreground", { altKey: true }],
  ]) {
    await check(name, async () => {
      await open();
      await holdCatalog();
      await type(query);
      await until("catalog load pending", () => run('return typeof globalThis.bangTestRelease === "function";'));
      const before = await state();
      await key("Enter", mods);
      assert.equal((await state()).tabs.length, before.tabs.length);
      await releaseCatalog();
      await opened(url, before, !!mods.metaKey);
      assert.equal(await run(`return globalThis.bangTestRequests.some(u=>u.includes(encodeURIComponent(${JSON.stringify(query)})));`), false);
    });
  }
  for (const action of ["edit", "escape", "outside click", "mode"]) {
    await check(`pending bang submission is cancelled by ${action}`, async () => {
      await open();
      await holdCatalog();
      await type("!gh cancelled");
      const before = await state();
      await key("Enter");
      if (action === "edit") await type("?replacement");
      else if (action === "escape") await key("Escape");
      else if (action === "outside click") await run('nn.store.getState().closePanel("w1");return true;');
      else await run('nn.store.getState().updateSettings({searchShortcutMode:"arc"});return true;');
      await releaseCatalog();
      await sleep(150);
      assert.equal((await state()).tabs.length, before.tabs.length);
      await run('nn.store.getState().updateSettings({searchShortcutMode:"duckduckgo"});return true;');
    });
  }

  await check("cold Enter resolves the bang before accepting a matching history page", async () => {
    await open();
    await holdCatalog();
    await run(
      'nn.store.setState({history:{default:[{url:"https://unrelated.example/",title:"!gh history-match",favicon:null,visits:20,lastVisit:Date.now()}]}});return true;',
    );
    await type("!gh history-match");
    assert.equal((await bar()).items[0].kind, "page");
    const before = await state();
    await key("Enter");
    await releaseCatalog();
    await opened("https://github.com/search?q=history-match", before);
  });

  for (const [query, expected, mods] of [
    ["react hooks !w", "https://wikipedia.org/w/index.php?search=react+hooks", {}],
    ["!yt", "https://www.youtube.com/", { ctrlKey: true }],
    ["!ют cats", "https://www.youtube.com/results?search_query=cats", {}],
    ["!gh a+b & c/d #x 100%", "https://github.com/search?q=a%2Bb+%26+c%2Fd+%23x+100%25", {}],
    ["!unknown-test cats", "https://www.google.com/search?q=!unknown-test%20cats", {}],
    ["?!gh forced", "https://www.google.com/search?q=!gh%20forced", {}],
    ["!work release notes", "https://docs.example/?q=release+notes", {}],
  ]) {
    await check(`DuckDuckGo mode submits ${query}`, async () => {
      await open();
      await type(query);
      await until("resolved first row", async () => (await bar()).items[0]?.url === expected);
      const before = await state();
      await key("Enter", mods);
      await opened(expected, before);
    });
  }
  await check("Cmd-Enter on a calculator still opens behind the current tab", async () => {
    await open();
    await type("1+1");
    assert.equal((await bar()).items[0].kind, "calc");
    const before = await state();
    await key("Enter", { metaKey: true });
    await opened("https://www.google.com/search?q=1%2B1", before, true);
  });
  await check("native Return opens the resolved bang", async () => {
    await open();
    await type("!gh native-return");
    await until("native bang ready", async () => (await bar()).items[0]?.bang);
    const before = await state();
    assert.equal(await run('return globalThis.expo.modules.BayApp.devPostKey("w1", "\\r", 36, []);'), true);
    await opened("https://github.com/search?q=native-return", before);
  });
  await check("editing and deleting a custom bang override updates its destination", async () => {
    const configured = await run('return nn.store.getState().addCustomEngine({name:"Local GitHub",keyword:"gh",url:"http://[::1]:3000/search?q=%s"});');
    assert.ok(configured.id);
    await open();
    await type("!gh local");
    await until("custom override", async () => (await bar()).items[0]?.url === "http://[::1]:3000/search?q=local");
    assert.equal(
      await run(
        `return nn.store.getState().updateCustomEngine(${JSON.stringify(configured.id)},{name:"Local GitHub",keyword:"gh",url:"https://code.example/search?q=%s"});`,
      ),
      null,
    );
    await until("edited override", async () => (await bar()).items[0]?.url === "https://code.example/search?q=local");
    await run(`nn.store.getState().removeCustomEngine(${JSON.stringify(configured.id)});return true;`);
    await until("restored bundled destination", async () => (await bar()).items[0]?.url === "https://github.com/search?q=local");
  });
  await check("an explicit site scope wins over bang syntax", async () => {
    await open();
    await type("yt");
    await key("Tab");
    await until("site scope", async () => (await bar()).scope?.name === "YouTube");
    await type("!gh scoped");
    assert.equal((await bar()).scopeColor, null);
    assert.equal((await bar()).items[0].url, "https://www.youtube.com/results?search_query=!gh%20scoped");
  });
  await check("Search settings render the mode selector and configuration", async () => {
    await run('nn.openSettings("search");return true;');
    await sleep(500);
    assert.equal(await run(`return nn.shell.devSnapshotWindow("settings",${JSON.stringify(join(data, "settings.png"))});`), true);
  });
  writeFileSync(join(data, "results.json"), JSON.stringify({ passed: results.length, results, data }, null, 2));
  console.log(`${results.length} checks passed; evidence: ${data}`);
} finally {
  await app.quit();
}
