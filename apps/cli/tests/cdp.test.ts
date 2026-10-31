import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Cdp, ConnectionLost } from "../src/cdp.ts";
import { runCode } from "../src/runner.ts";
import { ForbiddenCommand } from "../src/guard.ts";
import type { Endpoint } from "../src/endpoint.ts";

describe("CDP connection lifecycle", () => {
  let server: ReturnType<typeof Bun.serve>;
  let endpoint: Endpoint;
  beforeEach(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: undefined })) return;
        return new Response(null, { status: 404 });
      },
      websocket: {
        message(socket, raw) {
          const command = JSON.parse(String(raw));
          if (command.method === "Test.wait") return;
          else socket.send(JSON.stringify({ id: command.id, result: { targetInfos: [] } }));
        },
      },
    });
    endpoint = { ws: `ws://127.0.0.1:${server.port}/devtools/browser/test`, source: "test", explicit: true, active: null };
  });
  afterEach(() => server.stop(true));

  it("returns exec values through a real websocket", async () => {
    expect(await runCode("({ result: await Promise.resolve(42) })", "fixture.ts", endpoint, 1)).toEqual({ result: 42 });
  });
  it("rejects browser shutdown commands", async () => {
    const cdp = new Cdp(endpoint.ws);
    try {
      await cdp.open(1000);
      await expect(cdp.send("Browser.close")).rejects.toBeInstanceOf(ForbiddenCommand);
    } finally {
      await cdp.close();
    }
  });
  it("rejects in-flight commands on connection loss", async () => {
    const cdp = new Cdp(endpoint.ws);
    try {
      await cdp.open(1000);
      const pending = cdp.send("Test.wait");
      await cdp.close();
      await expect(pending).rejects.toBeInstanceOf(ConnectionLost);
    } finally {
      await cdp.close();
    }
  });
  it("exits 130 on SIGINT and releases its connection", async () => {
    const cli = new URL("../bin/bay.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, cli, "exec", 'console.log("ready"); await new Promise(() => {})', "--ws", endpoint.ws], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe("ready\n");
      child.kill("SIGINT");
      expect(await child.exited).toBe(130);
      reader.releaseLock();
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  });
  it("clears the default timeout so an embedded exec process can exit", async () => {
    const runnerUrl = new URL("../src/runner.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {runCode} from ${JSON.stringify(runnerUrl)}; console.log(await runCode('42', 'fixture.ts', ${JSON.stringify(endpoint)}, 300));`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill(), 2000);
    try {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("42\n");
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  });
});
