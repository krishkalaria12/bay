// The production selection action, page evaluator, native renderer and clipboard, in an isolated hidden app.
// node apps/browser/scripts/share-quote-test.mjs <Debug Bay.app>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appPath] = process.argv.slice(2);
if (!appPath) throw new Error("usage: node share-quote-test.mjs <Debug Bay.app>");
const scratch = mkdtempSync(join(tmpdir(), "bay-share-quote-"));
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Quote fixture</title><style>body{font:20px system-ui;padding:50px}</style>
    <p id="quote">A few meaningful words can change how we see the world.</p><div style="height:2000px"></div><p id="target">A passage worth sharing.</p>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/`;
let app;
try {
  app = await launch(resolve(appPath), {
    data: join(scratch, "data"),
    onboarded: true,
    session: session({
      settings: { launchTab: "lastTab" },
      tabs: [{ id: "quote", url, title: "Quote fixture" }],
      windows: [{ id: "quotes", tabIds: ["quote"], activeTabIds: { default: "quote" } }],
    }),
  });
  const nn = (body) => app.eval(body);
  const until = async (body) => {
    for (let i = 0; i < 100; i++) {
      const value = await nn(body);
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`Timed out: ${body}; evidence: ${scratch}`);
  };
  await until('return nn.store.getState().tabs.quote?.title === "Quote fixture" && nn.webviews.has("quote")');
  const page = await app.page(url.replace("http://", ""));
  const select = (id, text) =>
    page.eval(`(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      ${text === undefined ? "" : `element.textContent = ${JSON.stringify(text)};`}
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    })()`);
  const copy = () => nn('return nnSelection.shareSelectionQuote("quote").then(() => nn.toasts.getState().toasts.quotes)');
  const clipboard = () => execFileSync("pbpaste", { encoding: "utf8" });

  await select("target");
  const toast = await copy();
  assert.equal(toast.title, "Copied Quote");
  assert.equal(toast.action.title, "Share…");
  const link = clipboard();
  assert.equal(link, `${url}#:~:text=A%20passage%20worth%20sharing.`);
  // A new page load follows the shared link to the off-screen passage.
  await nn(`nn.store.getState().navigate("quote", ${JSON.stringify(link)}); return true`);
  await sleep(1200);
  const destination = await app.page(url.replace("http://", ""));
  assert.ok(await destination.eval("scrollY > 1000"), "Shared link scrolls to the passage");
  destination.close();

  await select("quote", "word ".repeat(500));
  assert.equal((await copy()).title, "Copied Quote", "Selections beyond the 2000-character popover preview are copied in full");
  const previousLink = clipboard();
  await select("quote", "a ".repeat(5000));
  assert.equal((await copy()).title, "Couldn't Share Quote");
  assert.equal(clipboard(), previousLink, "Rejected quotes leave the clipboard alone");
  await page.eval("getSelection().removeAllRanges()");
  assert.equal((await copy()).title, "Couldn't Share Quote");
  assert.equal(clipboard(), previousLink, "A lost selection leaves the clipboard alone");
  page.close();
  console.log(`Share Quote integration passed; evidence: ${scratch}`);
} finally {
  if (app) await app.quit();
  await new Promise((done) => server.close(done));
}
