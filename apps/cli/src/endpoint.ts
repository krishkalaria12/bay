import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { addSecret } from "./redact.ts";
import { expandHome, isRecord } from "./util.ts";

export const NOT_REACHABLE = 'Bay isn\'t running, or "Let the bay command control Bay" is off in Settings.';
export const CONTROL_FILE = "BayControl.json";
export const INSTALLED_DATA_DIR = join(homedir(), "Library", "Application Support", "in.krishkalaria.bay");
const BROWSER_PATH = /^\/devtools\/browser\/[0-9A-Za-z-]{1,128}$/;
const TOKEN = /^[\x21-\x7e]{16,1024}$/;
const MAX_CONTROL_FILE = 64 * 1024;

export class EndpointError extends Error {
  override name = "EndpointError";
}

export type Endpoint = {
  ws: string;
  source: string;
  explicit: boolean;
  active: string | null;
};

export type EndpointChoice = { ws?: string; port?: number; dataDir?: string };

export async function resolveEndpoint(choice: EndpointChoice = {}): Promise<Endpoint> {
  if (choice.ws) return fromWs(choice.ws, "--ws");
  if (choice.port !== undefined) return fromPort(choice.port);
  const envWs = process.env.BAY_CDP_URL;
  if (envWs) return fromWs(envWs, "BAY_CDP_URL");
  return fromControlFile(join(dataRoot(choice.dataDir), "Chromium", CONTROL_FILE));
}

export function dataRoot(dataDir?: string): string {
  const root = dataDir || process.env.BAY_DATA_DIR;
  return root ? expandHome(root) : INSTALLED_DATA_DIR;
}

export function explicitDataRoot(dataDir?: string): string | null {
  const root = dataDir || process.env.BAY_DATA_DIR;
  return root ? expandHome(root) : null;
}

export function requireControl(root: string): Endpoint {
  return fromControlFile(join(root, "Chromium", CONTROL_FILE));
}

function fromWs(url: string, source: string): Endpoint {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EndpointError(`${source} must be a ws://host:port/devtools/browser/<id> URL`);
  }
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || !parsed.host || !parsed.pathname.startsWith("/devtools/browser/")) {
    throw new EndpointError(`${source} must be a ws://host:port/devtools/browser/<id> URL`);
  }
  const token = parsed.searchParams.get("token");
  if (token) addSecret(token);
  return { ws: parsed.href, source, explicit: true, active: null };
}

async function fromPort(port: number): Promise<Endpoint> {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new EndpointError(`--port must be between 1 and 65535, not ${port}`);
  let answer: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    answer = await response.json();
  } catch (error) {
    throw new EndpointError(`no DevTools server answers on 127.0.0.1:${port} (${reason(error)})`);
  }
  const ws = isRecord(answer) ? answer.webSocketDebuggerUrl : null;
  if (typeof ws !== "string") throw new EndpointError(`127.0.0.1:${port}/json/version has no webSocketDebuggerUrl`);
  return fromWs(ws, `--port ${port}`);
}

export function fromControlFile(path: string): Endpoint {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new EndpointError(NOT_REACHABLE);
    if (code === "ELOOP") throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} is a symbolic link)`);
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} ${messageOf(error)})`);
  }
  let raw: string;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} isn't a regular file)`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} belongs to another user)`);
    }
    if ((info.mode & 0o777) !== 0o600) throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} must be mode 0600)`);
    if (info.size > MAX_CONTROL_FILE) throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} is too big)`);
    raw = readFileSync(fd, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof EndpointError) throw error;
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} ${messageOf(error)})`);
  } finally {
    closeSync(fd);
  }
  let control: unknown;
  try {
    control = JSON.parse(raw);
  } catch {
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} isn't valid JSON)`);
  }
  if (!isRecord(control)) throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} isn't valid)`);
  const port = control.port;
  const browser = control.browser;
  const token = control.token;
  const pid = control.pid;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} has no valid port)`);
  }
  if (typeof browser !== "string" || !BROWSER_PATH.test(browser)) {
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} has no valid browser path)`);
  }
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} has no valid token)`);
  }
  addSecret(token);
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || !alive(pid)) throw new EndpointError(NOT_REACHABLE);
  const query = `token=${encodeURIComponent(token)}`;
  return {
    ws: `ws://127.0.0.1:${port}${browser}?${query}`,
    source: path,
    explicit: false,
    active: `http://127.0.0.1:${port}/bay/active?${query}`,
  };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error) || "unreachable";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
