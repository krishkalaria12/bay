// `bay mcp`: Bay as a Model Context Protocol server for the coding agents people already run (Claude Code, Codex,
// Cursor, VS Code). It speaks MCP over stdio (JSON-RPC 2.0, one message a line) and drives Bay through the same
// DevTools connection `bay exec` uses, so it needs the same permission (Settings › Advanced › Let the bay command
// control Bay) and reaches only what that connection may: web page tabs, never Bay's own pages or private windows.
// With --agent (what `bay mcp install` writes) the agent asks for its own access, which the person allows in some
// spaces or all of them (agentAccess.ts). macOS, Windows and Linux alike.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";
import type { Session } from "./browser.ts";
import type { CdpObject } from "./cdp.ts";
import { isRecord, type JsonValue } from "./util.ts";

export const PROTOCOL_VERSION = "2025-06-18";

// MARK: Tools

type ToolArgs = Record<string, JsonValue>;

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: string; description: string }>; required?: string[] };
};

const TAB_ARG = { type: "string", description: "The tab's id from list_tabs; omitted, the tab the person is looking at." };

export const TOOLS: ToolDef[] = [
  {
    name: "list_tabs",
    description: "List Bay's open web page tabs: id, title, address, and which one the person is looking at.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "open_tab",
    description: "Open an address in a new Bay tab, in the background unless asked, and wait for it to load.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The address to open." }, foreground: { type: "boolean", description: "Show the tab." } },
      required: ["url"],
    },
  },
  {
    name: "navigate",
    description: "Load an address in a tab and wait for it.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "The address." }, tab: TAB_ARG }, required: ["url"] },
  },
  {
    name: "read_page",
    description: "A tab's title, address and visible text.",
    inputSchema: { type: "object", properties: { tab: TAB_ARG, max_chars: { type: "number", description: "At most this many characters (default 20000)." } } },
  },
  {
    name: "click",
    description: "Click the first element a CSS selector matches in a tab.",
    inputSchema: { type: "object", properties: { selector: { type: "string", description: "A CSS selector." }, tab: TAB_ARG }, required: ["selector"] },
  },
  {
    name: "type",
    description: "Type text into the first field a CSS selector matches, optionally pressing Return after.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "A CSS selector for the field." },
        text: { type: "string", description: "What to type." },
        submit: { type: "boolean", description: "Press Return after typing." },
        tab: TAB_ARG,
      },
      required: ["selector", "text"],
    },
  },
  { name: "screenshot", description: "A PNG of a tab's visible page.", inputSchema: { type: "object", properties: { tab: TAB_ARG } } },
];

const READ_TEXT = (max: number) => `(() => (document.body ? document.body.innerText : "").slice(0, ${max}))()`;

const text = (value: string): ToolContent[] => [{ type: "text", text: value }];

/** What the tools do with a tab: a Tab of a connected Session. */
export type McpTab = {
  readonly targetId: string;
  title(): Promise<string>;
  url(): Promise<string>;
  evaluate(expression: string): Promise<JsonValue>;
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  send(method: string, params?: CdpObject, timeoutMs?: number): Promise<CdpObject>;
};

/** What the tools act on: a connected Session, as `bay exec` makes one. */
export type McpBrowser = {
  pageTabs(active: string | null | undefined): Promise<McpTab[]>;
  newTab(url: string, background: boolean): Promise<McpTab>;
  currentTab(tabs: McpTab[], active: string | null | undefined): Promise<McpTab | null>;
  activeTarget(): Promise<string | null | undefined>;
};

async function tabOf(browser: McpBrowser, args: ToolArgs): Promise<McpTab> {
  const id = args.tab;

  if (v.is(v.string(), id) && id) {
    const tabs = await browser.pageTabs(undefined);
    const tab = tabs.find((t) => t.targetId === id);

    if (!tab) throw new Error(`no tab ${id}; list_tabs gives the open ones`);

    return tab;
  }

  const active = await browser.activeTarget();
  const tab = await browser.currentTab(await browser.pageTabs(active), active);

  if (!tab) throw new Error("the person isn't on a web page; pass a tab from list_tabs, or open_tab");

  return tab;
}

const stringArg = (args: ToolArgs, name: string) => {
  const value = args[name];

  if (!v.is(v.string(), value) || !value) throw new Error(`${name} is required`);

  return value;
};

/** Runs one tool. Throws a message for the agent when it can't. */
export async function callTool(browser: McpBrowser, name: string, args: ToolArgs): Promise<ToolContent[]> {
  if (name === "list_tabs") {
    const active = await browser.activeTarget();
    const tabs = await browser.pageTabs(active);
    const current = await browser.currentTab(tabs, active);
    const rows = await Promise.all(tabs.map(async (t) => ({ id: t.targetId, title: await t.title(), url: await t.url(), current: t === current })));

    return text(JSON.stringify(rows, null, 2));
  }

  if (name === "open_tab") {
    const tab = await browser.newTab(stringArg(args, "url"), args.foreground !== true);

    return text(JSON.stringify({ id: tab.targetId, title: await tab.title(), url: await tab.url() }));
  }

  if (name === "navigate") {
    const tab = await tabOf(browser, args);
    await tab.goto(stringArg(args, "url"));

    return text(JSON.stringify({ id: tab.targetId, title: await tab.title(), url: await tab.url() }));
  }

  if (name === "read_page") {
    const tab = await tabOf(browser, args);
    const max = v.is(v.number(), args.max_chars) && args.max_chars > 0 ? Math.min(Math.floor(args.max_chars), 200_000) : 20_000;
    const body = await tab.evaluate(READ_TEXT(max));

    return text(`# ${await tab.title()}\n${await tab.url()}\n\n${v.is(v.string(), body) ? body : ""}`);
  }

  if (name === "click") {
    const tab = await tabOf(browser, args);
    await tab.click(stringArg(args, "selector"));

    return text("clicked");
  }

  if (name === "type") {
    const tab = await tabOf(browser, args);
    await tab.type(stringArg(args, "selector"), stringArg(args, "text"));

    if (args.submit === true) await tab.pressKey("Enter");

    return text("typed");
  }

  if (name === "screenshot") {
    const tab = await tabOf(browser, args);
    const reply = await tab.send("Page.captureScreenshot", { format: "png" }, 30_000);

    if (!v.is(v.string(), reply.data)) throw new Error("Bay returned no image");

    return [{ type: "image", data: reply.data, mimeType: "image/png" }];
  }

  throw new Error(`no tool ${name}`);
}

// MARK: The protocol

const RequestSchema = v.object({
  jsonrpc: v.literal("2.0"),
  id: v.optional(v.union([v.string(), v.number()])),
  method: v.string(),
  params: v.optional(v.record(v.string(), v.unknown())),
});

type Reply = { jsonrpc: "2.0"; id: string | number | null; result?: JsonValue; error?: { code: number; message: string } };

/** The reply to one message, or null for a notification. `connect` makes the browser on first use. */
export async function handleMessage(line: string, connect: () => Promise<McpBrowser>, version: string): Promise<Reply | null> {
  let message: unknown;

  try {
    message = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
  }

  const parsed = v.safeParse(RequestSchema, message);

  if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  const { id, method, params } = parsed.output;

  if (id === undefined) return null;
  const reply = (result: JsonValue): Reply => ({ jsonrpc: "2.0", id, result });

  if (method === "initialize")
    return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "bay", title: "Bay", version } });

  if (method === "ping") return reply({});

  if (method === "tools/list") return reply({ tools: TOOLS });

  if (method === "tools/call") {
    const name = v.is(v.string(), params?.name) ? params.name : "";
    // SAFETY: isRecord checked a parsed JSON object, whose values are JSON values.
    const args = isRecord(params?.arguments) ? (params.arguments as ToolArgs) : {};

    try {
      const content = await callTool(await connect(), name, args);

      return reply({ content });
    } catch (error) {
      return reply({ content: text(error instanceof Error ? error.message : String(error)), isError: true });
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${method}` } };
}

// MARK: Installing into agents

export const MCP_AGENTS = ["claude-code", "codex", "cursor", "vscode"] as const;

export type McpAgent = (typeof MCP_AGENTS)[number];

/** Bay's entry in an agent's config: `bay mcp serve --agent <agent>`, so the agent asks for its own access. */
const entry = (agent: McpAgent) => ({ command: "bay", args: ["mcp", "serve", "--agent", agent] });

function vscodeConfig(home: string): string {
  if (process.platform === "darwin") return join(home, "Library/Application Support/Code/User/mcp.json");

  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData/Roaming"), "Code/User/mcp.json");

  return join(home, ".config/Code/User/mcp.json");
}

/** Where each agent keeps its MCP servers, for the person at `home`. */
export function mcpConfigPath(agent: McpAgent, home = homedir()): string {
  if (agent === "claude-code") return join(home, ".claude.json");

  if (agent === "codex") return join(home, ".codex/config.toml");

  if (agent === "cursor") return join(home, ".cursor/mcp.json");

  return vscodeConfig(home);
}

/** A JSON config with Bay's entry set under `key`, everything else as it was. */
export function withJsonEntry(existing: string, key: "mcpServers" | "servers", entry: Record<string, JsonValue>): string {
  const parsed: unknown = existing.trim() ? JSON.parse(existing) : {};
  const config = isRecord(parsed) ? { ...parsed } : {};
  const servers = isRecord(config[key]) ? { ...config[key] } : {};
  servers.bay = entry;
  config[key] = servers;

  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Codex's TOML with a `[mcp_servers.bay]` table, replacing Bay's old one and leaving every other line alone. */
export function withTomlEntry(existing: string, agent: McpAgent = "codex"): string {
  const lines = existing.split("\n");
  const kept: string[] = [];
  let inBay = false;

  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]$/);

    if (header) inBay = header[1] === "mcp_servers.bay" || header[1]!.startsWith("mcp_servers.bay.");

    if (!inBay) kept.push(line);
  }

  const body = kept.join("\n").replace(/\n+$/, "");

  return `${body ? `${body}\n\n` : ""}[mcp_servers.bay]\ncommand = "bay"\nargs = ${JSON.stringify(entry(agent).args).replaceAll(",", ", ")}\n`;
}

/** Adds Bay to an agent's MCP servers; the file's path. */
export function installMcp(agent: McpAgent, home = homedir()): string {
  const path = mcpConfigPath(agent, home);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  let next: string;

  if (agent === "codex") next = withTomlEntry(existing, agent);
  else if (agent === "vscode") next = withJsonEntry(existing, "servers", { type: "stdio", ...entry(agent) });
  else next = withJsonEntry(existing, "mcpServers", agent === "claude-code" ? { type: "stdio", ...entry(agent) } : entry(agent));

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);

  return path;
}

// MARK: Serving

/** Serves MCP on stdin and stdout until stdin closes. Bay is reached on the first tool call, and again after it goes. */
export async function serveMcp(connectSession: () => Promise<Session>, version: string): Promise<void> {
  let session: Session | null = null;

  const connect = async () => {
    session ??= await connectSession().catch((error: Error) => {
      session = null;
      throw error;
    });

    return session;
  };

  const decoder = new TextDecoder();
  let buffered = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    let end = buffered.indexOf("\n");

    while (end >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf("\n");

      if (!line) continue;
      const reply = await handleMessage(line, connect, version).catch(() => null);

      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  }

  // SAFETY: connect assigns session only inside the loop's awaits; TypeScript narrows it to null here.
  await (session as Session | null)?.close();
}
