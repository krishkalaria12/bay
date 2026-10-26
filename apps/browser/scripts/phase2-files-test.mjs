// node apps/browser/scripts/phase2-files-test.mjs <Debug Bay.app>
// Isolated data and local fixtures only. Native hooks use NSURL pasteboards and production drop destinations.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg] = process.argv.slice(2);
if (!appArg) throw new Error("usage: phase2-files-test.mjs <Debug Bay.app>");
const scratch = mkdtempSync(join(tmpdir(), "bay-phase2-files-"));
const data = join(scratch, "data");
const fixtures = join(scratch, "Finder fixtures");
mkdirSync(join(fixtures, "Folder", "Nested"), { recursive: true });
const html = join(fixtures, "Local #1.html");
const pdf = join(fixtures, "Report #1.pdf");
const image = join(fixtures, "Photo.png");
const folder = join(fixtures, "Folder");
writeFileSync(html, "<!doctype html><title>Local file acceptance</title><p id='proof'>Local file content</p>");
writeFileSync(join(folder, "Nested", "child.html"), "<!doctype html><title>Nested local file</title><p>Nested file</p>");
writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=", "base64"));
const content = "BT /F1 18 Tf 72 720 Td (Bay local file acceptance) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
];
let pdfText = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((object, index) => {
  offsets.push(Buffer.byteLength(pdfText));
  pdfText += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = Buffer.byteLength(pdfText);
pdfText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
  .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(pdf, pdfText);

const report = reporter(join(scratch, "files.log"), { name: "phase2-files" });
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>Native upload fixture</title><style>html,body{margin:0;width:100%;height:100%}body{background:#def}</style><p>Drop file here</p><script>
    window.uploads=[]; document.addEventListener('dragover', e=>e.preventDefault());
    document.addEventListener('drop', async e=>{e.preventDefault(); for(const f of e.dataTransfer.files) window.uploads.push({name:f.name,size:f.size,text:await f.text()});});
  </script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
let app;
let pins;
const run = (body) => app.eval(body);
const native = "globalThis.expo.modules.BayLocalFiles";
const until = async (description, body, timeout = 12000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
    const value = await run(body);
    if (value) return value;
  }
  throw new Error(`timed out: ${description}`);
};
const rowId = (id, relative = "") => `file|${encodeURIComponent(id)}${relative ? `|${encodeURIComponent(relative)}` : ""}`;
const callRow = (id, action, relative = "") =>
  run(
    `const row=nn.sidebarKeyboard.keyboardRows("w1").find(row=>row.id===${JSON.stringify(rowId(id, relative))}); if(!row) throw Error("Missing visible file row"); row.${action}(); return true`,
  );
const untilRow = (id, relative = "") =>
  until("file row", `return nn.sidebarKeyboard.keyboardRows("w1").some(row=>row.id===${JSON.stringify(rowId(id, relative))})`);
try {
  app = await launch(resolve(appArg), {
    data,
    onboarded: true,
    session: session({
      settings: { launchTab: "lastTab" },
      tabs: [{ id: "upload", url: base, title: "Native upload fixture" }],
    }),
  });
  await until("mounted upload page", 'return !!nn.webviews.get("upload")');
  await report.check("NSURL Finder drop inserts files and folders through the native drop destination", async () => {
    const result = await run(`return ${native}.devDrop("w1",${JSON.stringify([pdf, html, image, folder])})`);
    assert.equal(result.performed, true, JSON.stringify(result));
    assert.equal(result.destinationClass, "LocalFilesArea");
    assert.ok(result.types.includes("public.file-url"));
    await until("four file pins", "return Object.keys(nn.store.getState().localFiles).length===4");
    pins = await run("return Object.values(nn.store.getState().localFiles)");
    assert.deepEqual(pins.map((pin) => pin.path).sort(), [pdf, html, image, folder].sort());
    for (const pin of pins) {
      assert.deepEqual(Object.keys(pin).sort(), ["id", "spaceId", "path", "name", "kind", "createdAt", "order", "expanded"].sort());
      assert.equal((await run(`return nn.shell.localFiles.inspect(${JSON.stringify(pin.path)})`)).status, "available");
    }
    return result;
  });
  await report.check("native file rows open PDF, image and HTML tabs with real file content", async () => {
    for (const path of [pdf, image, html]) {
      const pin = pins.find((item) => item.path === path);
      await untilRow(pin.id);
      await callRow(pin.id, "open");
      await until("file tab", `return Object.values(nn.store.getState().tabs).some(tab=>tab.url===${JSON.stringify(pathToFileURL(path).href)})`);
    }
    const page = await app.page(pathToFileURL(html).href);
    try {
      assert.equal(await page.eval('document.querySelector("#proof")?.textContent'), "Local file content");
    } finally {
      page.close();
    }
  });
  await report.check("expanded filesystem children participate in keyboard traversal and open", async () => {
    const pin = pins.find((item) => item.path === folder);
    await run(`nn.store.getState().setLocalFileExpanded(${JSON.stringify(pin.id)},true); return true`);
    await untilRow(pin.id, "Nested");
    await run(`nn.sidebarKeyboard.keyboardRows("w1").find(row=>row.id===${JSON.stringify(rowId(pin.id, "Nested"))}).expand(false); return true`);
    await untilRow(pin.id, "Nested/child.html");
    const parentId = await run(
      `return nn.sidebarKeyboard.keyboardRows("w1").find(row=>row.id===${JSON.stringify(rowId(pin.id, "Nested/child.html"))}).parentId`,
    );
    assert.equal(parentId, rowId(pin.id, "Nested"));
    await callRow(pin.id, "open", "Nested/child.html");
    await until("nested file tab", 'return Object.values(nn.store.getState().tabs).some(tab=>tab.url.endsWith("Nested/child.html"))');
  });
  await report.check("native NSURL drop into Chromium exposes an upload File with the original PDF bytes", async () => {
    await run('nn.store.getState().activate("upload","w1"); return true');
    await until("upload active", 'return nn.store.getState().windows.w1.activeTabIds.default==="upload" && !!nn.webviews.get("upload")');
    const page = await app.page(base);
    try {
      assert.equal(await page.eval("Array.isArray(window.uploads)"), true);
      const result = await run(`return ${native}.devUpload("w1",${JSON.stringify(pdf)},"",800,400)`);
      assert.equal(result.sourceMounted, true, JSON.stringify(result));
      assert.equal(result.performed, true, JSON.stringify(result));
      assert.ok(result.types.includes("public.file-url"));
      let upload;
      for (const end = Date.now() + 10000; Date.now() < end; await sleep(100)) {
        upload = await page.eval("window.uploads[0]");
        if (upload) break;
      }
      assert.ok(upload, `Chromium did not deliver DataTransfer.files: ${JSON.stringify(result)}`);
      assert.equal(upload.name, "Report #1.pdf");
      assert.equal(upload.size, Buffer.byteLength(pdfText));
      assert.equal(upload.text, pdfText);
      return result;
    } finally {
      page.close();
    }
  });
  await report.check("pin and native access survive quitting and relaunching the isolated profile", async () => {
    await app.quit();
    const saved = JSON.parse(readFileSync(join(data, "session.json"), "utf8"));
    assert.equal(saved.localFiles.length, 4);
    assert.equal(JSON.stringify(saved.localFiles).includes("bookmark"), false);
    app = await launch(resolve(appArg), { data, onboarded: true });
    const pin = pins.find((item) => item.path === pdf);
    await untilRow(pin.id);
    assert.equal((await run(`return nn.shell.localFiles.inspect(${JSON.stringify(pdf)})`)).status, "available");
    await callRow(pin.id, "open");
    await until(
      "PDF active after relaunch",
      `const s=nn.store.getState(); return s.tabs[s.windows.w1.activeTabIds.default]?.url===${JSON.stringify(pathToFileURL(pdf).href)}`,
    );
  });
  await report.check("another Mac's metadata grants no access even when the same path exists", async () => {
    await app.quit();
    app = await launch(resolve(appArg), {
      data: join(scratch, "other-mac"),
      onboarded: true,
      session: session({
        tabs: [{ id: "upload", url: base }],
        localFiles: [...pins, { ...pins[0], id: "missing", path: join(scratch, "absent.pdf") }],
      }),
    });
    assert.equal((await run(`return nn.shell.localFiles.inspect(${JSON.stringify(pdf)})`)).status, "inaccessible");
    assert.equal((await run(`return nn.shell.localFiles.inspect(${JSON.stringify(join(scratch, "absent.pdf"))})`)).status, "missing");
  });
} finally {
  await app?.quit();
  server.close();
  writeFileSync(join(scratch, "results.json"), JSON.stringify({ failures: report.failed, scratch }, null, 2));
}
process.exitCode = report.summary() ? 0 : 1;
console.log(`Evidence: ${scratch}`);
