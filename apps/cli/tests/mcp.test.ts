import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callTool,
  handleMessage,
  installMcp,
  mcpConfigPath,
  PROTOCOL_VERSION,
  TOOLS,
  withJsonEntry,
  withTomlEntry,
  type McpBrowser,
  type McpTab,
} from "../src/mcp.ts";

function fakeTab(id: string, title: string, url: string): McpTab & { log: string[] } {
  const log: string[] = [];

  return {
    targetId: id,
    log,
    title: async () => title,
    url: async () => url,
    evaluate: async () => "Hello from the page",
    goto: async (to: string) => void log.push(`goto ${to}`),
    click: async (selector: string) => void log.push(`click ${selector}`),
    type: async (selector: string, text: string) => void log.push(`type ${selector} ${text}`),
    pressKey: async (key: string) => void log.push(`key ${key}`),
    send: async () => ({ data: "UE5H" }),
  };
}

function fakeBrowser() {
  const a = fakeTab("A", "First", "https://a.example/");
  const b = fakeTab("B", "Second", "https://b.example/");

  const browser: McpBrowser = {
    pageTabs: async () => [a, b],
    activeTarget: async () => "B",
    currentTab: async (tabs, active) => tabs.find((t) => t.targetId === active) ?? null,
    newTab: async (url) => fakeTab("C", "New", url),
  };

  return { a, b, browser };
}

type Message = { jsonrpc: string; id?: string | number; method: string; params?: { name?: string; arguments?: Record<string, string> } };

const line = (message: Message) => JSON.stringify(message);

describe("the protocol", () => {
  const connect = async () => fakeBrowser().browser;

  test("initialize names the server and its tools capability", async () => {
    const reply = await handleMessage(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), connect, "1.2.3");
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "bay", title: "Bay", version: "1.2.3" } },
    });
  });

  test("tools are listed, notifications get no reply, and bad input gets JSON-RPC errors", async () => {
    const list = await handleMessage(line({ jsonrpc: "2.0", id: "x", method: "tools/list" }), connect, "1");
    expect(list?.result).toEqual({ tools: TOOLS });
    expect(await handleMessage(line({ jsonrpc: "2.0", method: "notifications/initialized" }), connect, "1")).toBeNull();
    expect((await handleMessage("{not json", connect, "1"))?.error?.code).toBe(-32700);
    expect((await handleMessage(line({ jsonrpc: "2.0", id: 2, method: "nope" }), connect, "1"))?.error?.code).toBe(-32601);
  });

  test("a failing tool is a tool error for the agent, not a protocol error", async () => {
    const reply = await handleMessage(line({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: {} } }), connect, "1");
    expect(reply?.result).toEqual({ content: [{ type: "text", text: "selector is required" }], isError: true });
  });
});

describe("the tools", () => {
  test("list_tabs marks the tab the person is looking at", async () => {
    const { browser } = fakeBrowser();
    const [content] = await callTool(browser, "list_tabs", {});
    expect(JSON.parse(content!.type === "text" ? content!.text : "")).toEqual([
      { id: "A", title: "First", url: "https://a.example/", current: false },
      { id: "B", title: "Second", url: "https://b.example/", current: true },
    ]);
  });

  test("tools act on the current tab, or the one named", async () => {
    const { a, b, browser } = fakeBrowser();
    await callTool(browser, "type", { selector: "#q", text: "bay", submit: true });
    await callTool(browser, "click", { selector: "button", tab: "A" });
    expect(b.log).toEqual(["type #q bay", "key Enter"]);
    expect(a.log).toEqual(["click button"]);
    await expect(callTool(browser, "click", { selector: "x", tab: "Z" })).rejects.toThrow("no tab Z");
    const [page] = await callTool(browser, "read_page", {});
    expect(page).toEqual({ type: "text", text: "# Second\nhttps://b.example/\n\nHello from the page" });
    expect(await callTool(browser, "screenshot", {})).toEqual([{ type: "image", data: "UE5H", mimeType: "image/png" }]);
  });
});

describe("installing", () => {
  test("only Bay's entry changes in a JSON config", () => {
    const before = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" }, bay: { command: "old" } } });
    expect(JSON.parse(withJsonEntry(before, "mcpServers", { command: "bay", args: ["mcp", "serve"] }))).toEqual({
      theme: "dark",
      mcpServers: { other: { command: "x" }, bay: { command: "bay", args: ["mcp", "serve"] } },
    });
  });

  test("Codex's TOML gets one Bay table, replacing an old one and keeping the rest", () => {
    const before = 'model = "o3"\n\n[mcp_servers.bay]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "x"\n';
    expect(withTomlEntry(before)).toBe('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.bay]\ncommand = "bay"\nargs = ["mcp", "serve"]\n');
    expect(withTomlEntry("")).toBe('[mcp_servers.bay]\ncommand = "bay"\nargs = ["mcp", "serve"]\n');
  });

  test("install writes each agent's own file", () => {
    const home = mkdtempSync(join(tmpdir(), "bay-mcp-"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor/mcp.json"), '{"mcpServers":{"keep":{"command":"k"}}}');
    expect(installMcp("cursor", home)).toBe(mcpConfigPath("cursor", home));
    expect(JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8")).mcpServers.keep).toEqual({ command: "k" });
    installMcp("claude-code", home);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.bay.type).toBe("stdio");
    installMcp("codex", home);
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("[mcp_servers.bay]");
  });
});
