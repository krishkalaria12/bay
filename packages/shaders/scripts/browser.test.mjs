import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const moduleURL = new URL("./browser.mjs", import.meta.url).href;

async function runBrowser(browser) {
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { withChromium } from ${JSON.stringify(moduleURL)};
    // Metro keeps the process alive in the shader check, even if cleanup never settles.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await withChromium({ browser: ${JSON.stringify(browser)}, args: [], timeout: 1500 }, open => open("fixture.html"));
      throw new Error("unexpected success");
    } catch (error) {
      console.log(error.message);
    } finally {
      clearInterval(keepAlive);
    }
  `,
    ],
    { timeout: 8000 },
  );

  return stdout;
}

async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), "bay-browser-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const browser = join(dir, "browser.mjs");
  await writeFile(browser, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });

  return browser;
}

test("Chromium exiting during startup reports its stderr and finishes cleanup", async () => {
  // Node rejects Chromium's command-line options and exits before publishing a DevTools endpoint.
  assert.match(await runBrowser(process.execPath), /Chromium exited:[\s\S]*bad option/);
});

test("a missing Chromium executable rejects and finishes cleanup", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bay-browser-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.match(await runBrowser(join(dir, "missing")), /ENOENT/);
});

test("Chromium that never publishes an endpoint times out and is stopped", { skip: process.platform === "win32" }, async (t) => {
  const browser = await fixture(t, 'console.error("startup stalled"); setInterval(() => {}, 1000);');
  assert.match(await runBrowser(browser), /Chromium startup timed out[\s\S]*startup stalled/);
});

test("an unanswered DevTools command times out and closes the connection", { skip: process.platform === "win32" }, async (t) => {
  const browser = await fixture(
    t,
    `
    import { createServer } from "node:http";
    import { createHash } from "node:crypto";
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
      socket.on("data", () => {});
    });
    server.listen(0, "127.0.0.1", () => console.error("DevTools listening on ws://127.0.0.1:" + server.address().port));
  `,
  );

  assert.match(await runBrowser(browser), /Target.createTarget timed out/);
});
