import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as v from "valibot";
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

/** Where the running Bay is: --ws, else --port, else $BAY_CDP_URL, else the data dir's control file. */
export const resolveEndpoint = (choice: EndpointChoice = {}): Effect.Effect<Endpoint, EndpointError> =>
  Effect.suspend(() => {
    if (choice.ws) return endpointOf(() => fromWs(choice.ws!, "--ws"));

    if (choice.port !== undefined) return fromPort(choice.port);
    const envWs = process.env.BAY_CDP_URL;

    if (envWs) return endpointOf(() => fromWs(envWs, "BAY_CDP_URL"));

    return endpointOf(() => fromControlFile(join(dataRoot(choice.dataDir), "Chromium", CONTROL_FILE)));
  });

/** The control file's endpoint, as an Effect: Bay isn't reachable when it isn't valid. */
export const requireControlEffect = (root: string): Effect.Effect<Endpoint, EndpointError> => endpointOf(() => requireControl(root));

const endpointOf = (read: () => Endpoint): Effect.Effect<Endpoint, EndpointError> =>
  Effect.try({
    try: read,
    catch: (error) => (error instanceof EndpointError ? error : new EndpointError(error instanceof Error ? error.message : String(error))),
  });

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

// How long a plain DevTools server has to answer.
const PORT_TIMEOUT = Duration.seconds(3);

const fromPort = (port: number): Effect.Effect<Endpoint, EndpointError> =>
  Effect.gen(function* () {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return yield* Effect.fail(new EndpointError(`--port must be between 1 and 65535, not ${port}`));

    const unreachable = <E>(error: E) =>
      new EndpointError(`no DevTools server answers on 127.0.0.1:${port} (${reason(error instanceof Error ? error : String(error))})`);

    // The request is cancelled with the effect: a server that takes too long is not waited on.
    const answer = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body: unknown = await response.json();

        return body;
      },
      catch: unreachable,
    }).pipe(Effect.timeoutOrElse({ duration: PORT_TIMEOUT, orElse: () => Effect.fail(unreachable(new Error("timed out"))) }));

    const ws = isRecord(answer) ? answer.webSocketDebuggerUrl : null;

    if (!v.is(v.string(), ws)) return yield* Effect.fail(new EndpointError(`127.0.0.1:${port}/json/version has no webSocketDebuggerUrl`));

    return yield* endpointOf(() => fromWs(ws, `--port ${port}`));
  });

export function fromControlFile(path: string): Endpoint {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // SAFETY: openSync throws node:fs ErrnoExceptions, which carry the `code` this branches on.
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") throw new EndpointError(NOT_REACHABLE);

    if (code === "ELOOP") throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} is a symbolic link)`);
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} ${messageOf(error instanceof Error ? error : String(error))})`);
  }

  let raw: string;

  try {
    const info = fstatSync(fd);

    if (!info.isFile()) throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} isn't a regular file)`);

    if (process.getuid && info.uid !== process.getuid()) {
      throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} belongs to another user)`);
    }

    if ((info.mode & 0o777) !== 0o600) throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} must be mode 0600)`);

    if (info.size > MAX_CONTROL_FILE) throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} is too big)`);
    raw = readFileSync(fd, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof EndpointError) throw error;
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} ${messageOf(error instanceof Error ? error : String(error))})`);
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

  if (!v.is(v.number(), port) || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} has no valid port)`);
  }

  if (!v.is(v.string(), browser) || !BROWSER_PATH.test(browser)) {
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} has no valid browser path)`);
  }

  if (!v.is(v.string(), token) || !TOKEN.test(token)) {
    throw new EndpointError(`${NOT_REACHABLE} (${basename(path)} has no valid token)`);
  }

  addSecret(token);

  if (!v.is(v.number(), pid) || !Number.isInteger(pid) || pid <= 1 || !alive(pid)) throw new EndpointError(NOT_REACHABLE);
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
    // SAFETY: process.kill throws node:fs ErrnoExceptions; EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function reason(error: Error | string): string {
  if (error instanceof Error) return error.message || error.name;

  return error || "unreachable";
}

function messageOf(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}
