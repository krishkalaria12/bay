// Real-browser checks for the WebGL2 backend: every GLSL port compiles and links, the backdrop's grain has the
// contracted strength and cell size at DPR 1 and 2, the animated effects draw, a lost context comes back, and a
// settled scene stops drawing. Runs the package's own modules (types stripped) in headless Chromium over the
// DevTools protocol, with SwiftShader so it needs no GPU.
//   node scripts/check-web-shaders.mjs [path to chromium]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const page = fileURLToPath(new URL("../tests/web/fixture.html", import.meta.url));
const browser = process.argv[2] ?? process.env.CHROMIUM ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
if (!browser) throw new Error("Pass a Chromium path or set CHROMIUM");

// Serve src/ as browser modules: TypeScript stripped, extensionless relative imports pointed at their files.
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(page));
  const file = normalize(join(src, path));
  if (!file.startsWith(src) || !existsSync(file)) return res.writeHead(404).end();
  let code = readFileSync(file, "utf8");
  if (file.endsWith(".ts")) {
    code = stripTypeScriptTypes(code).replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (m, a, spec, b) =>
      spec.endsWith(".ts") ? m : `${a}${existsSync(join(dirname(file), `${spec}.ts`)) ? `${spec}.ts` : spec}${b}`,
    );
  }
  res.writeHead(200, { "content-type": "text/javascript" }).end(code);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), "bay-web-shaders-"));
const chrome = spawn(
  browser,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-first-run",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let failed = false;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    chrome.on("exit", () => reject(new Error(`Chromium exited:\n${log}`)));
  });
  const ws = new WebSocket(endpoint);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });

  for (const dpr of [1, 2]) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false }, sessionId);
    await send("Page.navigate", { url }, sessionId);
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate",
      {
        expression: "new Promise(r => { const t = () => window.results ? r(window.results) : setTimeout(t, 50); t(); })",
        awaitPromise: true,
        returnByValue: true,
        timeout: 30000,
      },
      sessionId,
    );
    if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
    for (const check of result.value) {
      console.log(`${check.ok ? "ok  " : "FAIL"} dpr ${dpr} · ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
      if (!check.ok) failed = true;
    }
    await send("Target.closeTarget", { targetId });
  }
  ws.close();
} finally {
  chrome.kill();
  server.close();
  await new Promise((r) => chrome.once("exit", r).once("error", r));
  rmSync(profile, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
