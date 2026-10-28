// Runs a page from tests/web/ in Chromium over the DevTools protocol, serving src/ as browser modules (TypeScript
// stripped, extensionless relative imports pointed at their files). The page sets `window.results` when done.
// Shared by check-web-shaders.mjs (SwiftShader) and apps/browser/scripts/perf/shader-bench.mjs (the real GPU).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const pages = fileURLToPath(new URL("../tests/web/", import.meta.url));

export function findChromium(explicit) {
  const browser = explicit ?? process.env.CHROMIUM ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  if (!browser) throw new Error("Pass a Chromium path or set CHROMIUM");
  return browser;
}

/**
 * Starts Chromium with `args` and calls `run(open)`. `open(page, { width, height, dpr, query })` loads
 * tests/web/<page> in a new tab and resolves with its `window.results`.
 */
export async function withChromium({ browser, args, scripts = {} }, run) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (Object.hasOwn(scripts, path)) return res.writeHead(200, { "content-type": "text/javascript" }).end(scripts[path]);
    if (path.endsWith(".html")) {
      const file = normalize(join(pages, path));
      if (!file.startsWith(pages) || !existsSync(file)) return res.writeHead(404).end();
      return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(file));
    }
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
  const origin = `http://127.0.0.1:${server.address().port}/`;

  const profile = mkdtempSync(join(tmpdir(), "bay-web-shaders-"));
  const chrome = spawn(browser, ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", ...args, "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
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
    const open = async (page, { width = 800, height = 600, dpr = 1, query = "", timeout = 60000 } = {}) => {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      try {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false }, sessionId);
        await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
        await send("Page.navigate", { url: `${origin}${page}${query}` }, sessionId);
        const { result, exceptionDetails } = await send(
          "Runtime.evaluate",
          {
            expression: "new Promise(r => { const t = () => window.results ? r(window.results) : setTimeout(t, 50); t(); })",
            awaitPromise: true,
            returnByValue: true,
            timeout,
          },
          sessionId,
        );
        if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
        return result.value;
      } finally {
        await send("Target.closeTarget", { targetId });
      }
    };
    const value = await run(open);
    ws.close();
    return value;
  } finally {
    chrome.kill();
    server.close();
    await new Promise((r) => chrome.once("exit", r).once("error", r));
    rmSync(profile, { recursive: true, force: true });
  }
}
