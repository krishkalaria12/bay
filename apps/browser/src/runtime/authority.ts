import { createBrowserStore, type BrowserStore } from "../store/browser";
import { createBrowserProjector, type BrowserProjection } from "./projection";
import { executeLocationCommand, parseLocationCommand, type LocationCommand, type LocationCommandEffects } from "./locationCommands";

// Native facts (for example updateLive) and hydration are deliberately absent.
export type BrowserCommand = LocationCommand
  | { method: "createWindow"; options?: { profileId?: string; incognito?: boolean; url?: string } }
  | { method: "newTab"; windowId: string; options?: { url?: string; background?: boolean } }
  | { method: "activate" | "closeTab"; tabId: string }
  | { method: "navigate"; tabId: string; url: string }
  | { method: "closeWindow"; windowId: string };

export type BrowserCommit = Readonly<{ epoch: string; revision: number; state: BrowserProjection }>;
export type CommandRequest = Readonly<{ epoch: string; clientId: string; requestId: number; command: BrowserCommand }>;
export type CommandReply = Readonly<{ clientId: string; requestId: number; commit: BrowserCommit; value: string | null }>;

type AuthorityErrorCode = "invalid_request" | "stale_epoch" | "request_conflict" | "request_expired" | "closed";
export class AuthorityError extends Error {
  readonly code: AuthorityErrorCode;
  constructor(code: AuthorityErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AuthorityError";
  }
}

const invalid = (message: string): never => { throw new AuthorityError("invalid_request", message); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid("expected an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("unexpected command field");
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1_048_576) return invalid("expected a nonempty string");
  return value;
}
function options(value: unknown, fields: Record<string, "string" | "boolean">): Record<string, string | boolean> | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  keys(input, Object.keys(fields));
  const result: Record<string, string | boolean> = {};
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(input, key)) continue;
    const item = input[key];
    if (typeof item !== fields[key]) invalid("invalid option type");
    if (typeof item === "string" && item.length > 1_048_576) invalid("option is too long");
    result[key] = item as string | boolean;
  }
  return result;
}
function commandFrom(value: unknown): BrowserCommand {
  const c = record(value);
  switch (c.method) {
    case "createWindow":
      keys(c, ["method", "options"]);
      return { method: c.method, options: options(c.options, { profileId: "string", incognito: "boolean", url: "string" }) };
    case "newTab":
      keys(c, ["method", "windowId", "options"]);
      return { method: c.method, windowId: text(c.windowId), options: options(c.options, { url: "string", background: "boolean" }) };
    case "activate":
    case "closeTab":
      keys(c, ["method", "tabId"]);
      return { method: c.method, tabId: text(c.tabId) };
    case "navigate":
      keys(c, ["method", "tabId", "url"]);
      return { method: c.method, tabId: text(c.tabId), url: text(c.url) };
    case "closeWindow":
      keys(c, ["method", "windowId"]);
      return { method: c.method, windowId: text(c.windowId) };
    case "openLocation":
    case "switchToExistingTab":
    case "requestNewTab":
    case "submitNewTab":
    case "dismissCommandPanel":
    case "openCommandPanel":
      return parseLocationCommand(c);
    default:
      return invalid("unknown browser command");
  }
}

/** In-process authority only. It does not authenticate renderer client identities. */
export function createBrowserAuthority({ epoch, store = createBrowserStore(), effects }: { epoch: string; store?: BrowserStore; effects?: LocationCommandEffects }) {
  text(epoch);
  const project = createBrowserProjector();
  let observed = store.getState();
  let commit: BrowserCommit = Object.freeze({ epoch, revision: 0, state: project(observed) });
  let executing = false;
  let closed = false;
  let queue = Promise.resolve();
  const listeners = new Set<(commit: BrowserCommit) => void>();
  const pendingCommits: BrowserCommit[] = [];
  let notifying = false;
  type SavedRequest = { fingerprint: string; reply: Promise<CommandReply> };
  const clients = new Map<string, { lastRequestId: number; replies: Map<number, SavedRequest> }>();

  function publish() {
    // Earlier subscribers can trigger nested cleanup updates. Their outer `state`
    // argument is stale by the time this listener runs.
    const state = store.getState();
    if (state === observed) return;
    const projection = project(state);
    observed = state;
    commit = Object.freeze({ epoch, revision: commit.revision + 1, state: projection });
    pendingCommits.push(commit);
    if (notifying) return;
    notifying = true;
    try {
      while (pendingCommits.length) {
        const next = pendingCommits.shift()!;
        for (const listener of [...listeners]) {
          try { listener(next); } catch (error) { console.error("[runtime] commit subscriber failed", error); }
        }
      }
    } finally {
      notifying = false;
    }
  }
  const unsubscribe = store.subscribe(() => { if (!executing) publish(); });

  function run(command: BrowserCommand): string | null {
    const s = store.getState();
    switch (command.method) {
      case "createWindow": return s.createWindow(command.options);
      case "newTab": return s.newTab(command.windowId, command.options);
      case "activate": s.activate(command.tabId); break;
      case "navigate": s.navigate(command.tabId, command.url); break;
      case "closeTab": s.closeTab(command.tabId); break;
      case "closeWindow": s.closeWindow(command.windowId); break;
      default: return executeLocationCommand(store, command, effects);
    }
    return null;
  }

  function dispatch(input: unknown): Promise<CommandReply> {
    try {
      if (closed) throw new AuthorityError("closed", "authority is closed");
      const request = record(input);
      keys(request, ["epoch", "clientId", "requestId", "command"]);
      if (request.epoch !== epoch) throw new AuthorityError("stale_epoch", "authority epoch has changed");
      const clientId = text(request.clientId);
      const requestId = request.requestId;
      if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId < 1) return invalid("request id must be a positive safe integer");
      const command = commandFrom(request.command);
      const fingerprint = JSON.stringify(command);
      let client = clients.get(clientId);
      if (!client) { client = { lastRequestId: 0, replies: new Map() }; clients.set(clientId, client); }
      const previous = client.replies.get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AuthorityError("request_conflict", "request id was reused for another command");
        return previous.reply;
      }
      if (requestId <= client.lastRequestId) throw new AuthorityError("request_expired", "request is too old to replay");
      client.lastRequestId = requestId;
      const reply = queue.then(() => {
        if (closed) throw new AuthorityError("closed", "authority is closed");
        executing = true;
        let value: string | null;
        try { value = run(command); } finally { executing = false; publish(); }
        // This exact immutable commit exists before the result is exposed.
        return Object.freeze({ clientId, requestId, commit, value });
      });
      queue = reply.then(() => {}, () => {});
      client.replies.set(requestId, { fingerprint, reply });
      // Retain recent replies, but never re-execute an evicted request. Sequence
      // numbers are scoped to a browser-authenticated client and epoch.
      const acceptedClient = client;
      void reply.finally(() => {
        while (acceptedClient.replies.size > 128) acceptedClient.replies.delete(acceptedClient.replies.keys().next().value!);
      }).catch(() => {});
      return reply;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return {
    getSnapshot: () => commit,
    subscribe(listener: (commit: BrowserCommit) => void) {
      if (closed) throw new AuthorityError("closed", "authority is closed");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch,
    close() { closed = true; unsubscribe(); listeners.clear(); clients.clear(); },
  };
}
