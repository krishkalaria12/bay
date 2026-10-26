// node apps/browser/scripts/external-link-rules-test.mjs <Debug Bay.app> [scratch directory]
// Runs in its own profile, opens only local fake pages, and quits only the instance it launched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, sleep } from "../../../scripts/lib/instance.mjs";
import { externalLinkRulesFixture, serveExternalLinkPages } from "./fixtures/external-link-rules.mjs";

const [appArg, scratchArg] = process.argv.slice(2);
if (!appArg) throw new Error("usage: external-link-rules-test.mjs <Debug Bay.app> [scratch directory]");
const appPath = resolve(appArg);
const scratch = scratchArg ? resolve(scratchArg) : mkdtempSync(join(tmpdir(), "bay-external-link-rules-"));
mkdirSync(scratch, { recursive: true });
const data = join(scratch, "data");
const pages = await serveExternalLinkPages();
const fixture = externalLinkRulesFixture(pages.baseURL);
writeFileSync(join(scratch, "fixture.json"), JSON.stringify(fixture, null, 2));
const report = reporter(join(scratch, "external-link-rules.log"), { name: "external-link-rules" });
const address = (path) => `${pages.baseURL}${path}`;
let app;
const run = (body) => app.eval(body);
const until = async (description, body) => {
  for (const end = Date.now() + 12000; Date.now() < end; await sleep(100)) {
    const result = await run(body);
    if (result) return result;
  }
  throw new Error(`timed out waiting for ${description}`);
};
const tab = (path) =>
  run(
    `const s=nn.store.getState(); const t=Object.values(s.tabs).find(t=>t.url===${JSON.stringify(address(path))}||t.url===${JSON.stringify(new URL(address(path)).href)}); return t ? {id:t.id,spaceId:t.spaceId,windowId:t.windowId,kind:s.windows[t.windowId]?.kind??"main"} : null;`,
  );
const send = (paths, sourceApp) =>
  run(`nn.externalLinks.openExternalUrls(${JSON.stringify(paths.map(address))},${JSON.stringify(sourceApp) ?? "undefined"}); return true;`);

try {
  app = await launch(appPath, { data, session: fixture, onboarded: true, urls: [address("/work/cold")] });
  await report.check("native cold-launch external URL opens in Work", async () => {
    await until("cold external link", `return Object.values(nn.store.getState().tabs).some(t=>t.url===${JSON.stringify(address("/work/cold"))})`);
    const cold = await tab("/work/cold");
    assert.equal(cold.spaceId, "work");
    assert.equal(cold.kind, "main");
    const page = await app.page("/work/cold");
    try {
      for (const end = Date.now() + 10000; Date.now() < end && (await page.eval("document.title")) !== "Fake link /work/cold"; await sleep(100)) {}
      assert.equal(await page.eval("document.title"), "Fake link /work/cold");
    } finally {
      page.close();
    }
    return cold;
  });
  await report.check("source-app filtering and first-match priority follow rule order", async () => {
    await send(["/source/slack"], "com.tinyspeck.slackmacgap");
    await send(["/source/mail"], "com.apple.mail");
    assert.equal((await tab("/source/slack")).spaceId, "work");
    assert.equal((await tab("/source/mail")).kind, "small");
    await run(
      `const s=nn.store.getState(); const rules=[...s.settings.externalLinkRules]; const fallback=rules.splice(rules.findIndex(r=>r.id==="source-default"),1)[0]; rules.unshift(fallback); s.updateSettings({externalLinkRules:rules}); return true;`,
    );
    await send(["/source/reordered"], "com.tinyspeck.slackmacgap");
    assert.equal((await tab("/source/reordered")).kind, "small");
    await run(`nn.store.getState().updateSettings({externalLinkRules:${JSON.stringify(fixture.settings.externalLinkRules)}}); return true;`);
    return { slack: await tab("/source/slack"), mail: await tab("/source/mail"), reordered: await tab("/source/reordered") };
  });
  await report.check("explicit Little Bay and new-window rules override the default", async () => {
    const before = await run("return nn.store.getState().windowOrder");
    await send(["/quick/preview"]);
    await send(["/window/dedicated"]);
    const quick = await tab("/quick/preview");
    const window = await tab("/window/dedicated");
    assert.equal(quick.kind, "small");
    assert.equal(window.kind, "main");
    assert.equal(window.spaceId, "default");
    assert.ok(!before.includes(window.windowId));
    assert.notEqual(quick.windowId, window.windowId);
    return { quick, window };
  });
  await report.check("unmatched and missing-space links use defaults, including batches", async () => {
    await send(["/unmatched/main"]);
    assert.equal((await tab("/unmatched/main")).kind, "main");
    assert.equal((await tab("/unmatched/main")).spaceId, "default");
    await run(
      `const s=nn.store.getState(); s.updateSettings({openLinksInLittleBay:true,externalLinkRules:[{id:"missing",pattern:${JSON.stringify(new URL(pages.baseURL).host + "/missing/*")},destination:{kind:"space",spaceId:"deleted-space"}},...s.settings.externalLinkRules]}); return true;`,
    );
    await send(["/unmatched/small"]);
    await send(["/missing/fallback"]);
    assert.equal((await tab("/unmatched/small")).kind, "small");
    assert.equal((await tab("/missing/fallback")).kind, "small");
    await send(["/unmatched/batch-a", "/unmatched/batch-b"]);
    for (const path of ["/unmatched/batch-a", "/unmatched/batch-b"]) {
      assert.equal((await tab(path)).kind, "small");
      assert.equal((await tab(path)).spaceId, "default");
    }
    return {
      single: await tab("/unmatched/small"),
      missing: await tab("/missing/fallback"),
      batch: [await tab("/unmatched/batch-a"), await tab("/unmatched/batch-b")],
    };
  });
  await report.check("contains and exact routes include queries, fragments and Unicode paths", async () => {
    await send([
      "/reports/weekly?view=board#today",
      "/reports/weekly?view=list#today",
      "/reports/weekly?view=board#tomorrow",
      "/café/page",
      "/legacy-café/page",
    ]);
    assert.equal((await tab("/reports/weekly?view=board#today")).spaceId, "work");
    assert.equal((await tab("/reports/weekly?view=list#today")).kind, "small");
    assert.equal((await tab("/reports/weekly?view=board#tomorrow")).kind, "small");
    assert.equal((await tab("/café/page")).spaceId, "work");
    assert.equal((await tab("/legacy-café/page")).spaceId, "work");
  });
  await report.check("most recent and explicit default Spaces route independently of the browser default", async () => {
    await run(
      'const s=nn.store.getState();s.switchSpace("w1","work");s.setFocusedWindow("w1");s.updateSettings({externalLinkDefault:{kind:"mostRecentSpace"}});return true;',
    );
    await send(["/recent/rule", "/unmatched/recent"]);
    assert.equal((await tab("/recent/rule")).spaceId, "work");
    assert.equal((await tab("/unmatched/recent")).spaceId, "work");
    await run('nn.store.getState().updateSettings({externalLinkDefault:{kind:"space",spaceId:"work"}});return true;');
    await send(["/unmatched/chosen"]);
    assert.equal((await tab("/unmatched/chosen")).spaceId, "work");
    assert.equal(await run("return nn.store.getState().settings.defaultSpaceId"), "default");
  });
  await report.check("Peek Open as Tab follows routing through the keyboard command", async () => {
    const target = await run('return nn.store.getState().createWindow({spaceId:"work"})');
    const peek = await run(
      `const s=nn.store.getState();s.activate("intro","w1");s.setFocusedWindow("w1");return s.openPeek("intro",${JSON.stringify(address("/work/peek"))});`,
    );
    await sleep(300);
    await run('nn.runCommand({command:"openFile",windowId:"w1"});return true;');
    assert.equal((await tab("/work/peek")).windowId, target);
    assert.equal((await tab("/work/peek")).spaceId, "work");
    assert.equal(await run("return nn.store.getState().windows.w1.spaceId"), "default");
    assert.equal(await run("return nn.store.getState().peeks.w1??null"), null);
    assert.equal(await run(`return nn.store.getState().tabs[${JSON.stringify(peek)}].peekOf??null`), null);
    const livePeek = await run(
      `const s=nn.store.getState();s.activate("intro","w1");return s.openPeek("intro",${JSON.stringify(address("/quick/peek-live"))});`,
    );
    const page = await app.page("/quick/peek-live");
    try {
      await page.eval('window.atcLiveMarker="preserved"');
      await run('nn.runCommand({command:"openFile",windowId:"w1"});return true;');
      await until("Little Bay transfer", `const s=nn.store.getState();return s.windows[s.tabs[${JSON.stringify(livePeek)}]?.windowId]?.kind==="small";`);
      assert.equal((await tab("/quick/peek-live")).id, livePeek);
      assert.equal(await page.eval("window.atcLiveMarker"), "preserved", "routing preserves the live page instead of reloading the URL");
    } finally {
      page.close();
    }
  });
  await report.check("deleting a Space removes local and synced routes and repairs its routing default", async () => {
    await run(
      `const s=nn.store.getState();const id=s.createSpace({name:"Temporary"});s.updateSettings({externalLinkDefault:{kind:"space",spaceId:id},externalLinkRules:[...s.settings.externalLinkRules,{id:"deleted-local",matchType:"contains",pattern:"deleted-local",destination:{kind:"space",spaceId:id}},{id:"deleted-synced",matchType:"contains",pattern:"deleted-synced",destination:{kind:"space",spaceId:id,syncProfileId:"temporary-profile"}}]});s.deleteSpace(id);return true;`,
    );
    assert.equal(await run('return nn.store.getState().settings.externalLinkRules.some(r=>r.id.startsWith("deleted-"))'), false);
    assert.deepEqual(await run("return nn.store.getState().settings.externalLinkDefault"), { kind: "space", spaceId: "default" });
  });
  await report.check("rule editor validates empty text and saves Contains rules through native typing", async () => {
    await run('nn.openSettings("links");return true;');
    await sleep(700);
    await run("nn.linkRules.showRuleEditor();return true;");
    await sleep(300);
    const before = await run("return nn.store.getState().settings.externalLinkRules.length");
    await run(`return nn.shell.devTypeKeys("settings",${JSON.stringify("editor-café?view=board#today\r")},15);`);
    const saved = await run("return nn.store.getState().settings.externalLinkRules.at(-1)");
    assert.equal(saved.matchType, "contains");
    assert.equal(saved.pattern, "editor-café?view=board#today");
    assert.equal(await run("return nn.store.getState().settings.externalLinkRules.length"), before + 1);
    await run("nn.linkRules.showRuleEditor();return true;");
    await sleep(300);
    await run(`return nn.shell.devTypeKeys("settings",${JSON.stringify("\r")},15);`);
    assert.equal(await run("return nn.store.getState().settings.externalLinkRules.length"), before + 1);
    await run(`return nn.shell.devTypeKeys("settings",${JSON.stringify("\u001b")},15);`);
  });
  await report.check("ordered rules persist across Debug app restart and appear in Links settings", async () => {
    await run(
      `nn.store.getState().updateSettings({externalLinkRules:${JSON.stringify(fixture.settings.externalLinkRules)},externalLinkDefault:{kind:"mostRecentSpace"}}); return true;`,
    );
    await until(
      "saved rules",
      `const saved=JSON.parse(nn.shell.readDocument("session.json")); return JSON.stringify(saved.settings.externalLinkRules)===${JSON.stringify(JSON.stringify(fixture.settings.externalLinkRules))} && saved.settings.openLinksInLittleBay===false;`,
    );
    await app.quit();
    app = await launch(appPath, { data });
    assert.deepEqual(await run("return nn.store.getState().settings.externalLinkRules"), fixture.settings.externalLinkRules);
    assert.deepEqual(await run("return nn.store.getState().settings.externalLinkDefault"), { kind: "mostRecentSpace" });
    await send(["/work/restored"]);
    assert.equal((await tab("/work/restored")).spaceId, "work");
    await run('nn.openSettings("links"); return true;');
    await sleep(700);
    await until("Links settings screenshot", `return nn.shell.devSnapshotWindow("settings",${JSON.stringify(join(scratch, "links-settings.png"))});`);
    return { rules: fixture.settings.externalLinkRules.map((r) => r.id), screenshot: join(scratch, "links-settings.png") };
  });
} finally {
  await app?.quit();
  await pages.close();
  writeFileSync(
    join(scratch, "results.json"),
    JSON.stringify({ passed: !report.failed.length && report.results.length === 10, failures: report.failed, scratch }, null, 2),
  );
}
process.exitCode = report.summary() ? 0 : 1;
console.log(`Fake data and screenshots: ${scratch}`);
