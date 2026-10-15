// Opens a visible, separate Debug browser with fake local rules. Keep this process running for the local pages.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attach, launch } from "../../../scripts/lib/instance.mjs";
import { externalLinkRulesFixture, serveExternalLinkPages } from "./fixtures/external-link-rules.mjs";

const [first, dataArg, url, sourceApp] = process.argv.slice(2);
if (first === "--send") {
  if (!dataArg || !url) throw new Error("usage: dev:links --send <profile directory> <url> [source app bundle id]");
  const target = attach(dataArg);
  await target.eval(`nn.externalLinks.openExternalUrls([${JSON.stringify(url)}],${JSON.stringify(sourceApp) ?? "undefined"}); return true;`);
  console.log(`Sent ${url} to playground pid ${target.pid}${sourceApp ? ` from ${sourceApp}` : ""}`);
  process.exit(0);
}

const app = first ? resolve(first) : fileURLToPath(new URL("../build-dev/Build/Products/Debug/Bay.app", import.meta.url));
if (!existsSync(join(app, "Contents/Info.plist"))) throw new Error("Build the Debug app first with pnpm dev:app, or pass a Debug Bay.app path");
const status = await fetch("http://localhost:8081/status")
  .then((r) => r.text())
  .catch(() => "");
if (!status.includes("packager-status:running")) throw new Error("Start Metro with pnpm dev before opening the rules playground");
const pages = await serveExternalLinkPages();
const data = mkdtempSync(join(tmpdir(), "bay-link-rules-playground-"));
let instance;
try {
  instance = await launch(app, { data, session: externalLinkRulesFixture(pages.baseURL), onboarded: true, js: "live", env: { BAY_BACKGROUND: "0" } });
  await instance.eval('return nn.shell.focusWindow("w1")');
} catch (error) {
  await instance?.quit();
  await pages.close();
  throw error;
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
console.log(`Opened external link rules playground, pid ${instance.pid}. Fake profile: ${data}`);
console.log("Open Settings → Links to edit rules. From the repository root, send a link to this exact playground:");
const sendCommand = `pnpm --filter @bay/browser dev:links --send ${quote(data)}`;
for (const path of ["/work/demo", "/quick/demo", "/window/demo", "/unmatched/demo"]) console.log(`${sendCommand} ${quote(pages.baseURL + path)}`);
console.log(`${sendCommand} ${quote(pages.baseURL + "/source/slack")} com.tinyspeck.slackmacgap`);
console.log(`${sendCommand} ${quote(pages.baseURL + "/source/mail")} com.apple.mail`);
console.log(`Optional native macOS delivery: open -a ${quote(app)} ${quote(pages.baseURL + "/work/native")}`);
console.log("macOS may select another instance of the same build; --send always targets this fake profile.");
console.log("Keep this process running for the fake pages. Ctrl+C closes this playground and its local server.");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await instance.quit();
    await pages.close();
    process.exit(0);
  });
