import { DEFAULT_SETTINGS } from "../store/settings";
import type { BrowserCommand, BrowserCommit, CommandReply, CommandRequest } from "./authority";
import type { BrowserProjection } from "./projection";

export type BrowserClientTransport = {
  getSnapshot(): Promise<BrowserCommit>;
  dispatch(request: CommandRequest): Promise<CommandReply>;
  subscribeCommits(listener: (commit: BrowserCommit) => void): () => void;
  subscribeClose(listener: () => void): () => void;
};
export type BrowserClientStatus = "initializing" | "ready" | "resyncing" | "closed";
import { validateBrowserCommandResult, type BrowserCommandValue } from "./userCommands";
export type { BrowserCommandValue } from "./userCommands";
type ClientErrorCode = "closed" | "transport_closed" | "epoch_changed" | "invalid_protocol" | "snapshot_failed";
export class BrowserClientError extends Error {
  readonly code: ClientErrorCode;
  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.name = "BrowserClientError";
    this.code = code;
  }
}

const invalid = (): never => {
  throw new BrowserClientError("invalid_protocol", "invalid browser runtime message");
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  return value as Record<string, unknown>;
}
function copyJson(value: unknown, previous?: unknown, ancestors = new Set<object>(), depth = 0, omitUndefined = false): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || depth > 128 || ancestors.has(value)) return invalid();
  if (!Array.isArray(value)) record(value);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const before = Array.isArray(previous) ? previous : undefined;
      const copied = Array.from(value, (item, index) => copyJson(item, before?.[index], ancestors, depth + 1, omitUndefined));
      return before?.length === copied.length && copied.every((item, index) => item === before[index]) ? before : Object.freeze(copied);
    }
    const before = previous && typeof previous === "object" && !Array.isArray(previous) ? (previous as Record<string, unknown>) : undefined;
    const entries = Object.entries(value)
      .filter(([, item]) => !omitUndefined || item !== undefined)
      .map(([key, item]) => [key, copyJson(item, before?.[key], ancestors, depth + 1, omitUndefined)] as const);
    if (before && Object.keys(before).length === entries.length && entries.every(([key, item]) => Object.hasOwn(before, key) && before[key] === item))
      return before;
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}
// Every data slice is required. This is a complete snapshot, never a partial
// object passed through hydrate. Native facts and domain repair stay at source.
const projectionFields: Record<keyof BrowserProjection, "array" | "record"> = {
  services: "record",
  localFiles: "record",
  sidebarUndo: "record",
  spaces: "record",
  spaceOrder: "array",
  orphanedProfileData: "array",
  windows: "record",
  windowOrder: "array",
  closedWindows: "array",
  pinnedFolders: "record",
  folderMoveUndo: "array",
  tabs: "record",
  tabLists: "record",
  peeks: "record",
  closedPeeks: "record",
  live: "record",
  closedTabs: "array",
  groups: "record",
  selection: "record",
  cleanedTabs: "array",
  privateCleanedTabs: "record",
  privateSiteMutes: "record",
  closedGroups: "array",
  deletedGroups: "array",
  splits: "record",
  history: "record",
  historyReady: "record",
  historyFloor: "record",
  bookmarks: "record",
  bookmarksReady: "record",
  bookmarkUndo: "array",
  settings: "record",
  ui: "record",
  windowUi: "record",
  find: "record",
  downloads: "array",
};
export function decodeBrowserCommit(value: unknown, previous: BrowserCommit | null = null): BrowserCommit {
  const input = record(copyJson(value, previous));
  if (Object.keys(input).length !== 3 || Object.keys(input).some((key) => !["epoch", "revision", "state"].includes(key))) invalid();
  if (typeof input.epoch !== "string" || !input.epoch || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0) invalid();
  const state = record(input.state);
  if (Object.keys(state).length !== Object.keys(projectionFields).length || Object.keys(state).some((key) => !Object.hasOwn(projectionFields, key))) invalid();
  for (const [key, kind] of Object.entries(projectionFields)) {
    if (kind === "array") {
      if (!Array.isArray(state[key])) invalid();
    } else record(state[key]);
  }
  for (const key of ["spaceOrder", "windowOrder", "orphanedProfileData"]) {
    if (!(state[key] as unknown[]).every((item) => typeof item === "string")) invalid();
  }
  const settings = record(state.settings);
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const item = settings[key];
    if (fallback === null) {
      if (item !== null && (typeof item !== "number" || !Number.isFinite(item))) invalid();
    } else if (Array.isArray(fallback)) {
      if (!Array.isArray(item)) invalid();
    } else if (typeof fallback === "object") record(item);
    else if (typeof item !== typeof fallback) invalid();
  }
  const ui = record(state.ui);
  if (
    (ui.focusedWindowId !== null && typeof ui.focusedWindowId !== "string") ||
    typeof ui.appDark !== "boolean" ||
    !Array.isArray(ui.focusOrder) ||
    !ui.focusOrder.every((id) => typeof id === "string")
  )
    invalid();
  const bookmarks = record(state.bookmarks);
  record(bookmarks.nodes);
  record(bookmarks.roots);
  return Object.freeze({ epoch: input.epoch as string, revision: input.revision as number, state: state as BrowserProjection });
}
function barrier() {
  let resolve!: (commit: BrowserCommit) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<BrowserCommit>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // The bootstrap owner may attach its ready handler after a synchronous close.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

// About ten seconds for a runtime that isn't ready yet.
const SNAPSHOT_RETRIES = 40;
const SNAPSHOT_RETRY_MS = 250;
const errorCode = (error: unknown) => (error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined);

/** A read-only mirror. The browser must authenticate its transport and clientId.
 * Complete authority projections contain private data and must be filtered by
 * the native broker before this is connected to a visible renderer.
 */
export function createBrowserClient({ clientId, transport }: { clientId: string; transport: BrowserClientTransport }) {
  if (!clientId) throw new Error("browser client id is required");
  let status: BrowserClientStatus = "initializing";
  let current: BrowserCommit | null = null;
  let buffered: BrowserCommit | null = null;
  let terminalError: BrowserClientError | null = null;
  let snapshotInFlight = false;
  let snapshotRetries = 0;
  let availability = barrier();
  const ready = availability.promise;
  let nextRequestId = 0;
  let unsubscribeCommits = () => {};
  let unsubscribeClose = () => {};
  const listeners = new Set<() => void>();
  type Pending = { request: CommandRequest; baseRevision: number; reply?: CommandReply; resolve(value: unknown): void; reject(error: unknown): void };
  const pending = new Map<number, Pending>();

  function notify() {
    // oxlint-disable-next-line no-useless-spread -- callbacks can change the next delivery's subscribers
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[runtime] mirror subscriber failed", error);
      }
    }
  }
  function fail(error: BrowserClientError) {
    if (terminalError) return;
    terminalError = error;
    status = "closed";
    availability.reject(error);
    for (const command of pending.values()) command.reject(error);
    pending.clear();
    buffered = null;
    for (const dispose of [unsubscribeCommits, unsubscribeClose]) {
      try {
        dispose();
      } catch (cause) {
        console.error("[runtime] transport cleanup failed", cause);
      }
    }
    notify();
    listeners.clear();
  }
  function sameEpoch(commit: BrowserCommit) {
    const expected = current?.epoch ?? buffered?.epoch;
    if (expected && commit.epoch !== expected) {
      fail(new BrowserClientError("epoch_changed", "browser runtime changed; a fresh browser bootstrap is required"));
      return false;
    }
    return true;
  }
  function settle() {
    if (status !== "ready" || !current) return;
    for (const [id, command] of pending) {
      if (!command.reply || command.reply.commit.revision > current.revision) continue;
      pending.delete(id);
      command.resolve(command.reply.value);
    }
  }
  function install(commit: BrowserCommit) {
    if (!current || commit.revision > current.revision) current = commit;
  }
  function beginResync() {
    if (status === "ready") {
      status = "resyncing";
      availability = barrier();
      notify();
    }
    requestSnapshot();
  }
  function acceptCommit(input: unknown) {
    if (terminalError) return;
    let commit: BrowserCommit;
    try {
      commit = decodeBrowserCommit(input, current);
    } catch {
      fail(new BrowserClientError("invalid_protocol", "invalid browser runtime commit"));
      return;
    }
    acceptValidatedCommit(commit);
  }
  function acceptValidatedCommit(commit: BrowserCommit) {
    if (!sameEpoch(commit)) return;
    if (current && commit.revision <= current.revision) return;
    if (status !== "ready") {
      if (!buffered || commit.revision > buffered.revision) buffered = commit;
      return;
    }
    if (commit.revision !== current!.revision + 1) {
      buffered = commit;
      beginResync();
      return;
    }
    install(commit);
    notify();
    settle();
  }
  function requestSnapshot() {
    if (snapshotInFlight || terminalError) return;
    snapshotInFlight = true;
    const minimumRevision = buffered?.revision ?? current?.revision ?? 0;
    void Promise.resolve()
      .then(() => {
        if (terminalError) throw terminalError;
        return transport.getSnapshot();
      })
      .then((input) => {
        snapshotInFlight = false;
        if (terminalError) return;
        const commit = decodeBrowserCommit(input, current);
        if (!sameEpoch(commit)) return;
        if (commit.revision < minimumRevision || (current && commit.revision < current.revision)) return invalid();
        install(commit);
        const waiting = buffered;
        buffered = null;
        if (waiting && waiting.revision > current!.revision) {
          if (waiting.revision === current!.revision + 1) install(waiting);
          else {
            buffered = waiting;
            notify();
            requestSnapshot();
            return;
          }
        }
        snapshotRetries = 0;
        status = "ready";
        availability.resolve(current!);
        notify();
        settle();
      })
      .catch((error: unknown) => {
        snapshotInFlight = false;
        if (terminalError) return;
        // The runtime is between coordinators (a window opening as another replaces it): ask again once it's back.
        if (errorCode(error) === "not_ready" && snapshotRetries < SNAPSHOT_RETRIES) {
          snapshotRetries++;
          setTimeout(requestSnapshot, SNAPSHOT_RETRY_MS);
          return;
        }
        const cause = error instanceof Error ? `: ${error.message}` : "";
        fail(error instanceof BrowserClientError ? error : new BrowserClientError("snapshot_failed", `browser runtime snapshot failed${cause}`));
      });
  }
  function receiveReply(command: Pending, input: unknown) {
    if (terminalError || !pending.has(command.request.requestId)) return;
    try {
      const reply = record(input);
      if (
        Object.keys(reply).some((key) => !["clientId", "requestId", "commit", "value"].includes(key)) ||
        reply.clientId !== clientId ||
        reply.requestId !== command.request.requestId
      )
        invalid();
      if (!validateBrowserCommandResult(command.request.command, reply.value)) invalid();
      const commit = decodeBrowserCommit(reply.commit, current);
      if (!sameEpoch(commit)) return;
      if (commit.revision < command.baseRevision) invalid();
      command.reply = Object.freeze({ clientId, requestId: command.request.requestId, commit, value: copyJson(reply.value) });
      acceptValidatedCommit(commit);
      settle();
    } catch {
      fail(new BrowserClientError("invalid_protocol", "invalid browser runtime command reply"));
    }
  }
  async function dispatch<C extends BrowserCommand>(input: C): Promise<BrowserCommandValue<C>> {
    if (terminalError) throw terminalError;
    // Detach immediately, before bootstrap or resync waits can yield to callers.
    // Optional undefined fields have the same representation as a JSON request.
    const command = copyJson(input, undefined, new Set(), 0, true) as BrowserCommand;
    while (status !== "ready") {
      if (terminalError) throw terminalError;
      await availability.promise;
    }
    if (terminalError) throw terminalError;
    if (!Number.isSafeInteger(++nextRequestId)) throw new BrowserClientError("invalid_protocol", "browser request sequence is exhausted");
    const request: CommandRequest = Object.freeze({ epoch: current!.epoch, clientId, requestId: nextRequestId, command });
    return new Promise<BrowserCommandValue<C>>((resolve, reject) => {
      const item: Pending = { request, baseRevision: current!.revision, resolve: (value) => resolve(value as BrowserCommandValue<C>), reject };
      pending.set(request.requestId, item);
      void Promise.resolve()
        .then(async () => {
          while (status !== "ready") {
            if (terminalError) throw terminalError;
            await availability.promise;
          }
          if (terminalError) throw terminalError;
          if (!pending.has(request.requestId)) throw new BrowserClientError("closed", "browser command is no longer pending");
          if (request.epoch !== current!.epoch) throw new BrowserClientError("epoch_changed", "browser runtime changed before the command was sent");
          item.baseRevision = current!.revision;
          return transport.dispatch(request);
        })
        .then(
          (reply) => receiveReply(item, reply),
          (error: unknown) => {
            if (terminalError || !pending.has(request.requestId)) return;
            if (error && typeof error === "object" && "code" in error && error.code === "stale_epoch") {
              fail(new BrowserClientError("epoch_changed", "browser runtime changed; the command outcome is uncertain"));
              return;
            }
            pending.delete(request.requestId);
            reject(error);
          },
        );
    });
  }

  try {
    const releaseCommits = transport.subscribeCommits(acceptCommit);
    if (terminalError) releaseCommits();
    else unsubscribeCommits = releaseCommits;
    const releaseClose = transport.subscribeClose(() =>
      fail(new BrowserClientError("transport_closed", "browser runtime transport closed; pending command outcomes are uncertain")),
    );
    if (terminalError) releaseClose();
    else unsubscribeClose = releaseClose;
    requestSnapshot();
  } catch {
    fail(new BrowserClientError("transport_closed", "browser runtime transport could not connect"));
  }
  return {
    ready,
    getSnapshot: () => current,
    getStatus: () => status,
    subscribe(listener: () => void) {
      if (terminalError) throw terminalError;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch,
    close() {
      fail(new BrowserClientError("closed", "browser runtime client closed"));
    },
  };
}
