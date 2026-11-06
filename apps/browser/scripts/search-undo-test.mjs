// Native search-field editing acceptance in an isolated desktop profile.
// node apps/browser/scripts/search-undo-test.mjs <Debug Bay.app>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

if (!process.argv[2]) throw new Error("Provide the Debug Bay.app path");

const scratch = mkdtempSync(join(tmpdir(), "bay-search-undo-"));
const report = reporter(join(scratch, "undo.log"), { name: "search-undo" });
let app;
let clipboard;
const run = (body) => app.eval(body);
const driver = 'nn.omnibox.get("w1:palette")';
const state = () => run(`return ${driver}?.state()`);
const menu = (perform) => run(`return globalThis.expo.modules.BayApp.devMenuItems("textInput:w1", ${JSON.stringify(perform ?? null)})`);

async function until(label, read) {
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(50)) if (await read()) return;
  throw new Error(`Timed out: ${label}`);
}

const text = (expected) => until(`field contains ${JSON.stringify(expected)}`, async () => (await state())?.typed === expected);

const key = (shift = false) =>
  run(`return nn.shell.devKeyEquivalent("w1", {key:"z", keyCode:6, modifiers:${JSON.stringify(shift ? ["command", "shift"] : ["command"])}, asKey:true})`);

const left = async (count = 1) => {
  for (let i = 0; i < count; i++) await run('return globalThis.expo.modules.BayApp.devPostKey("w1", "\\uF702", 123, ["function"])');
  await sleep(100);
};

const backspace = () => run('return globalThis.expo.modules.BayApp.devPostKey("w1", "\\u007F", 51, [])');

async function open() {
  await run('nn.store.getState().closePanel("w1"); return true');
  await until("old field unmounted", () => run(`return !${driver}`));
  await run('nn.store.getState().openNewTabPanel("w1"); return true');
  await until("new field mounted", () => run(`return !!${driver}`));
  await text("");
}

try {
  app = await launch(resolve(process.argv[2]), {
    data: join(scratch, "data"),
    onboarded: true,
    session: session({ tabs: [{ id: "a", url: "about:blank", title: "Search undo" }] }),
  });
  clipboard = execFileSync("pbpaste", { encoding: "utf8" });
  await run(`globalThis.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve(["",[]])});
    nn.store.getState().updateTab("a", {customTitle:"Sidebar change"}); return true`);
  const sidebarUndo = await run("return nn.store.getState().sidebarUndo.w1.length");
  await open();
  await report.check("fresh search exposes disabled Undo and Redo with standard shortcuts", async () => {
    const items = await menu();
    assert.deepEqual(
      items.slice(0, 2).map(({ title, enabled, key }) => ({ title, enabled, key })),
      [
        { title: "Undo", enabled: false, key: "z" },
        { title: "Redo", enabled: false, key: "z" },
      ],
    );
    assert.equal(items[0].modifiers, 1 << 20);
    assert.equal(items[1].modifiers, (1 << 20) | (1 << 17));
  });
  await report.check("menu Cut and Undo restore the query and Redo cuts it again", async () => {
    await run('return nn.shell.devTypeKeys("w1", "original query", 20)');
    await text("original query");
    await menu(["Select All"]);
    await menu(["Cut"]);
    await text("");
    assert.equal((await menu()).find((item) => item.title === "Undo").enabled, true);
    await menu(["Undo"]);
    await text("original query");
    assert.equal((await menu()).find((item) => item.title === "Redo").enabled, true);
    await menu(["Redo"]);
    await text("");
  });
  await report.check("menu Paste and keyboard Undo/Redo share the field history", async () => {
    await menu(["Undo"]);
    await text("original query");
    await menu(["Select All"]);
    await run('nn.shell.copyText("replacement query"); return true');
    await sleep(100);
    await menu(["Paste"]);
    await text("replacement query");
    await key();
    await text("original query");
    await key(true);
    await text("replacement query");
    await key();
    await text("original query");
    await menu(["Select All"]);
    await run('return nn.shell.devTypeKeys("w1", "new query", 20)');
    await text("new query");
    assert.equal((await menu()).find((item) => item.title === "Redo").enabled, false);
  });
  await report.check("search editing leaves sidebar history intact and a new search starts fresh", async () => {
    assert.equal(await run("return nn.store.getState().sidebarUndo.w1.length"), sidebarUndo);
    assert.equal(await run("return nn.store.getState().tabs.a.customTitle"), "Sidebar change");
    await open();
    assert.equal((await menu()).find((item) => item.title === "Undo").enabled, false);
    assert.equal((await menu()).find((item) => item.title === "Redo").enabled, false);
  });
  await report.check("context-menu Paste keeps multiline queries on one line", async () => {
    await run('nn.shell.copyText("alpha\\n beta\\n gamma"); return true');
    await sleep(100);
    await menu(["Paste"]);
    await text("alpha beta gamma");
    await key();
    await text("");
  });
  await report.check("a typed run undoes as one step and replacing it starts another", async () => {
    await open();
    await run('return nn.shell.devTypeKeys("w1", "first query", 20)');
    await text("first query");
    await menu(["Select All"]);
    await run('return nn.shell.devTypeKeys("w1", "second", 20)');
    await text("second");
    await key();
    await text("first query");
    await key();
    await text("");
    await key(true);
    await text("first query");
    await key(true);
    await text("second");
  });
  await report.check("repeated Undo before the field reports back keeps Redo", async () => {
    await open();

    for (const value of ["alpha", "beta", "gamma"]) {
      await menu(["Select All"]);
      await run(`nn.shell.copyText(${JSON.stringify(value)}); return true`);
      await sleep(100);
      await menu(["Paste"]);
      await text(value);
    }

    const press = 'nn.shell.devKeyEquivalent("w1", {key:"z", keyCode:6, modifiers:["command"], asKey:true})';
    await run(`return Promise.all([${press}, ${press}])`);
    await text("alpha");
    await sleep(200);
    assert.equal((await menu()).find((item) => item.title === "Redo").enabled, true);
    await key(true);
    await text("beta");
    await key(true);
    await text("gamma");
  });
  await report.check("Undo drops an inline suggestion with the typing it followed", async () => {
    await run(
      'nn.store.getState().importHistory("default", [{url:"https://example.com/path", title:"Example", visits:20, lastVisit:Date.now()}]); return true',
    );
    await open();
    await run('return nn.shell.devTypeKeys("w1", "exa", 100)');
    await text("exa");
    await until("inline completion", async () => (await state())?.value === "example.com");
    await menu(["Undo"]);
    await text("");
    await key(true);
    await text("exa");
    await until("inline completion again", async () => (await state())?.value === "example.com");
  });
  await report.check("Undo and Redo move in and out of a scope with its text", async () => {
    const inScope = (want) => until(`scope ${want}`, async () => ((await state())?.scope?.host ?? null) === want);
    await open();
    await run('return nn.shell.devTypeKeys("w1", "exa", 100)');
    await until("inline completion", async () => (await state())?.value === "example.com");
    await run(`return ${driver}.key("Tab", {})`);
    await inScope("example.com");
    await text("");
    await key();
    await text("exa");
    await inScope(null);
    await key(true);
    await text("");
    await inScope("example.com");
    await run('return nn.shell.devTypeKeys("w1", "cats", 20)');
    await text("cats");
    await key();
    await text("");
    await inScope("example.com");
    await key(true);
    await text("cats");
    await key();
    await text("");
    await run(`return ${driver}.key("Backspace", {})`);
    await inScope(null);
    await text("exa");
    await key();
    await text("");
    await inScope("example.com");
    await run('return nn.shell.devTypeKeys("w1", "dogs", 20)');
    await text("dogs");
    await run(`return ${driver}.key("Escape", {})`);
    await inScope(null);
    await text("dogs");
    await key();
    await text("dogs");
    await inScope("example.com");
    await key(true);
    await text("dogs");
    await inScope(null);
  });
  await report.check("a scope restored by Redo still returns its text on Backspace", async () => {
    await open();
    await run('return nn.shell.devTypeKeys("w1", "exa", 100)');
    await until("inline completion", async () => (await state())?.value === "example.com");
    await run(`return ${driver}.key("Tab", {})`);
    await until("scope", async () => (await state())?.scope?.host === "example.com");
    await key();
    await text("exa");
    await key(true);
    await until("scope again", async () => (await state())?.scope?.host === "example.com");
    await text("");
    await run(`return ${driver}.key("Backspace", {})`);
    await text("exa");
  });
  await report.check("typing and deleting in the middle undo as one step", async () => {
    await open();
    await run('return nn.shell.devTypeKeys("w1", "helloworld", 20)');
    await text("helloworld");
    await left(5);
    await run('return nn.shell.devTypeKeys("w1", " big ", 20)');
    await text("hello big world");
    await key();
    await text("helloworld");
    await key(true);
    await text("hello big world");
    await key();
    await text("helloworld");
    await key();
    await text("");
    await run('return nn.shell.devTypeKeys("w1", "helloworld", 20)');
    await text("helloworld");
    await left(2);
    await backspace();
    await backspace();
    await text("hellowld");
    await key();
    await text("helloworld");
  });
  await report.check("Undo puts the caret back where the edit happened", async () => {
    await open();
    await run('return nn.shell.devTypeKeys("w1", "abcdef", 20)');
    await text("abcdef");
    await left(3);
    await run('return nn.shell.devTypeKeys("w1", "XY", 20)');
    await text("abcXYdef");
    await key();
    await text("abcdef");
    await run('return nn.shell.devTypeKeys("w1", "Z", 20)');
    await text("abcZdef");
    await key();
    await text("abcdef");
    await left(1);
    await backspace();
    await text("acdef");
    await key();
    await text("abcdef");
  });
  await report.check("repeated letters in the middle join a run and moving the caret ends it", async () => {
    await open();
    await run('return nn.shell.devTypeKeys("w1", "baaac", 20)');
    await text("baaac");
    await left(2);
    await run('return nn.shell.devTypeKeys("w1", "aaa", 20)');
    await text("baaaaaac");
    await key();
    await text("baaac");
    await left(1);
    await run('return nn.shell.devTypeKeys("w1", "x", 20)');
    await text("baxaac");
    await left(1);
    await run('return nn.shell.devTypeKeys("w1", "y", 20)');
    await text("bayxaac");
    await key();
    await text("baxaac");
    await key();
    await text("baaac");
  });
  await report.check("Undo returns the typed text after Tab accepts a suggestion", async () => {
    await run(
      'nn.store.getState().importHistory("default", [{url:"http://localhost:3000/dashboard", title:"Local", visits:20, lastVisit:Date.now()}]); return true',
    );
    await open();
    await run('return nn.shell.devTypeKeys("w1", "local", 100)');
    await text("local");
    await until("inline completion", async () => ((await state())?.value ?? "").startsWith("localhost"));
    const accepted = (await state()).value;
    assert.equal((await state()).tabScope, null);
    await run(`return ${driver}.key("Tab", {})`);
    await text(accepted);
    await key();
    await text("local");
    await key();
    await text("");
    await key(true);
    await text("local");
    await until("inline completion again", async () => (await state())?.value === accepted);
    await key(true);
    await text(accepted);
  });
  await report.check("Undo to the text a suggestion already shows still commits it", async () => {
    await open();
    await run('return nn.shell.devTypeKeys("w1", "example.com", 30)');
    await text("example.com");
    await menu(["Select All"]);
    await run('return nn.shell.devTypeKeys("w1", "exa", 100)');
    await text("exa");
    await until("inline completion", async () => (await state())?.value === "example.com");
    await key();
    await text("example.com");
    await key(true);
    await text("exa");
    await key();
    await text("example.com");
    await key();
    await text("");
  });
} finally {
  if (clipboard !== undefined) execFileSync("pbcopy", { input: clipboard });
  await app?.quit();
}

process.exitCode = report.summary() ? 0 : 1;

console.log(`Evidence: ${scratch}`);
