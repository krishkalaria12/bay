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

const src = fileURLToPath(new URL("../src", import.meta.url));
const pages = fileURLToPath(new URL("../tests/web/", import.meta.url));
const valibot = fileURLToPath(import.meta.resolve("valibot"));

function deadline(promise, timeout, label) {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function findChromium(explicit) {
  const browser = explicit ?? process.env.CHROMIUM ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);

  if (!browser) throw new Error("Pass a Chromium path or set CHROMIUM");

  return browser;
}

/**
 * Starts Chromium with `args` and calls `run(open)`. `open(page, { width, height, dpr, query })` loads
 * tests/web/<page> in a new tab and resolves with its `window.results`.
 */
export async function withChromium({ browser, args, scripts = {}, timeout = 30000 }, run) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);

    if (Object.hasOwn(scripts, path)) return res.writeHead(200, { "content-type": "text/javascript" }).end(scripts[path]);

    if (path === "/valibot.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(valibot));

    if (path.endsWith(".html")) {
      const file = normalize(join(pages, path));

      if (!file.startsWith(pages) || !existsSync(file)) return res.writeHead(404).end();

      // The raw TypeScript modules use the same validator as the bundled application.
      const imports = '<script type="importmap">{"imports":{"valibot":"/valibot.js"}}</script>';

      return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(file, "utf8").replace("<script", `${imports}<script`));
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

  // Register before startup can fail; an exit event cannot be awaited a second time during cleanup.
  const exited = new Promise((resolve) => chrome.once("exit", resolve).once("error", resolve));
  let ws;

  try {
    let log = "";

    const endpoint = await deadline(
      new Promise((resolve, reject) => {
        chrome.stderr.on("data", (d) => {
          log += d;
          const m = log.match(/DevTools listening on (ws:\/\/\S+)/);

          if (m) resolve(m[1]);
        });
        chrome.once("error", reject);
        chrome.once("exit", () => reject(new Error("Chromium exited:")));
      }),
      timeout,
      "Chromium startup",
    ).catch((error) => {
      throw new Error(`${error.message}\n${log}`, { cause: error });
    });

    ws = new WebSocket(endpoint);
    await deadline(
      new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("Chromium DevTools connection failed")), { once: true });
      }),
      timeout,
      "Chromium DevTools connection",
    );
    let id = 0;
    const waiting = new Map();
    ws.addEventListener("message", ({ data }) => {
      const msg = JSON.parse(data);

      if (msg.id && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    });

    ws.addEventListener("close", () => {
      for (const receive of waiting.values()) receive({ error: { message: "Chromium DevTools connection closed" } });
      waiting.clear();
    });

    const send = (method, params = {}, sessionId, requestTimeout = timeout) => {
      const n = ++id;

      return deadline(
        new Promise((resolve, reject) => {
          waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
          ws.send(JSON.stringify({ id: n, method, params, sessionId }));
        }),
        requestTimeout,
        method,
      ).finally(() => waiting.delete(n));
    };

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
          timeout + 1000,
        );

        if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));

        return result.value;
      } finally {
        await send("Target.closeTarget", { targetId });
      }
    };

    return await run(open);
  } finally {
    ws?.close();
    chrome.kill();
    server.close();
    server.closeAllConnections();
    await deadline(exited, 5000, "Chromium shutdown").catch(async () => {
      chrome.kill("SIGKILL");
      await exited;
    });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
