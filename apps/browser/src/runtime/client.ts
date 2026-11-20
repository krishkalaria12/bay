import * as v from "valibot";
import { DEFAULT_SETTINGS } from "../store/settings";
import { checked } from "../lib/checked";
import { isJsonObject, type JsonInput, type JsonObject, type JsonValue } from "../lib/json";
import { span, spanStart, timed } from "@bay/platform/profiling";
import { jsonKind } from "@bay/platform/json";
import type { BrowserCommand, BrowserCommit, CommandReply, CommandRequest } from "./authority";
import type { BrowserProjection } from "./projection";

/** A command's reply as the browser sends it: its commit may name only the revision, without the state. */
type ClientReply = Omit<CommandReply, "commit"> & { commit: BrowserCommit | Pick<BrowserCommit, "epoch" | "revision"> };

export type BrowserClientTransport = {
  getSnapshot(): Promise<BrowserCommit>;
  dispatch(request: CommandRequest): Promise<ClientReply>;
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

const invalid: () => never = () => {
  throw new BrowserClientError("invalid_protocol", "invalid browser runtime message");
};

/** A plain object of JSON fields: the shape a runtime message arrives in. */
function record(value: JsonInput): JsonObject {
  if (!isJsonObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();

  return value;
}

const TEXT = v.string();
const NUMBER = v.number();

/** A frozen copy of JSON data that reuses `previous`'s nodes wherever they hold the same data, so a subscriber sees
 *  an unchanged node as the same object. With `adopt`, deeply frozen input nodes are kept rather than copied: only
 *  the transport's freshly parsed, frozen messages are passed that way. */
function copyJson(value: JsonInput, previous?: JsonInput, ancestors = new Set<object>(), depth = 0, omitUndefined = false, adopt = false): JsonValue {
  const kind = jsonKind(value);

  if (kind === "leaf") return value!;

  // SAFETY: jsonKind found an array or a plain object.
  const node = checked<JsonValue[] | JsonObject>(value);

  if (kind === null || depth > 128 || ancestors.has(node)) return invalid();
  ancestors.add(node);

  try {
    // Kept whole when every item is the input's own (adopt) or the previous node's.
    const keep = adopt && Object.isFrozen(node);

    if (Array.isArray(node)) {
      const before = Array.isArray(previous) && previous.length === node.length ? previous : undefined;
      let copied: JsonValue[] | undefined;
      let same = !!before;
      let own = keep;

      for (let index = 0; index < node.length; index++) {
        const item = copyJson(node[index], before?.[index], ancestors, depth + 1, omitUndefined, adopt);
        const sameNow = same && item === before![index];
        const ownNow = own && item === node[index];

        // The items so far are the previous node's while `same` holds, else the input's own.
        if (!copied && !sameNow && !ownNow) copied = (same ? before! : node).slice(0, index);
        same = sameNow;
        own = ownNow;
        copied?.push(item);
      }

      if (same) return before!;

      if (own) return node;

      // SAFETY: a frozen array still holds the JSON values it was copied from.
      return Object.freeze(copied ?? []) as JsonValue[];
    }

    const before = isJsonObject(previous) ? previous : undefined;
    const keys = Object.keys(node);
    let copied: JsonObject | undefined;
    let count = 0;
    let same = !!before;
    let own = keep;

    // The fields so far are the previous node's while `same` holds, else the input's own.
    const start = (upTo: string | null) => {
      const source = same ? before! : node;
      copied = {};

      for (const key of keys) {
        if (key === upTo) break;

        if (!(omitUndefined && node[key] === undefined)) copied[key] = source[key]!;
      }
    };

    for (const key of keys) {
      const field = node[key];

      if (omitUndefined && field === undefined) {
        if (!copied && !same && own) start(key);
        own = false;
        continue;
      }

      const item = copyJson(field, before?.[key], ancestors, depth + 1, omitUndefined, adopt);
      const sameNow = same && Object.hasOwn(before!, key) && before![key] === item;
      const ownNow = own && item === field;

      if (!copied && !sameNow && !ownNow) start(key);
      same = sameNow;
      own = ownNow;
      count++;

      if (copied) copied[key] = item;
    }

    if (same && Object.keys(before!).length === count) return before!;

    if (own) return node;

    // Every field matched the previous node's, but it had others.
    if (!copied) start(null);

    return Object.freeze(copied!);
  } finally {
    ancestors.delete(node);
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
  // SAFETY: the checks above established this shape.
  bookmarkUndo: "array",
  settings: "record",
  ui: "record",
  windowUi: "record",
  find: "record",
  downloads: "array",
};

export function decodeBrowserCommit(value: JsonInput, previous: BrowserCommit | null = null): BrowserCommit {
  const input = record(copyJson(value, checked<JsonInput>(previous), new Set(), 0, false, true));

  if (Object.keys(input).length !== 3 || Object.keys(input).some((key) => !["epoch", "revision", "state"].includes(key))) invalid();

  // SAFETY: the checks above established this shape.

  const epoch = input.epoch;
  const revision = input.revision;

  if (!v.is(v.string(), epoch)) invalid();

  if (!epoch) invalid();

  if (!v.is(v.number(), revision) || !Number.isSafeInteger(revision) || revision < 0) invalid();
  const state = record(input.state);

  if (Object.keys(state).length !== Object.keys(projectionFields).length || Object.keys(state).some((key) => !Object.hasOwn(projectionFields, key))) invalid();

  for (const [key, kind] of Object.entries(projectionFields)) {
    if (kind === "array") {
      if (!Array.isArray(state[key])) invalid();
    } else record(state[key]);
  }

  for (const key of ["spaceOrder", "windowOrder", "orphanedProfileData"]) {
    if (!v.is(v.array(v.string()), state[key])) invalid();
  }

  const settings = record(state.settings);

  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const item = settings[key];

    if (fallback === null) {
      if (item !== null && (!v.is(v.number(), item) || !Number.isFinite(item))) invalid();
    } else if (Array.isArray(fallback)) {
      // SAFETY: the checks above established this shape.
      if (!Array.isArray(item)) invalid();
    } else if (v.is(v.string(), fallback)) {
      if (!v.is(v.string(), item)) invalid();
    } else if (v.is(v.boolean(), fallback)) {
      if (!v.is(v.boolean(), item)) invalid();
    } else if (v.is(v.number(), fallback)) {
      if (!v.is(v.number(), item)) invalid();
    } else record(item);
  }

  const ui = record(state.ui);

  if ((ui.focusedWindowId !== null && !v.is(v.string(), ui.focusedWindowId)) || !v.is(v.boolean(), ui.appDark) || !v.is(v.array(v.string()), ui.focusOrder))
    invalid();
  const bookmarks = record(state.bookmarks);
  record(bookmarks.nodes);
  record(bookmarks.roots);

  // SAFETY: the checks above established this shape.

  // SAFETY: the epoch and the revision were checked above, and the state holds exactly the projection's fields.
  return Object.freeze({ epoch, revision, state: checked<BrowserProjection>(state) });
}

function barrier() {
  let resolve!: (commit: BrowserCommit) => void;
  let reject!: (error: Error) => void;

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

/** The code a transport failure carries, when it has one. */
const errorCode = (cause: unknown): string | undefined => {
  if (!v.is(v.object({ code: v.optional(v.string()) }), cause)) return undefined;

  return cause.code ?? undefined;
};

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

  type Pending = {
    request: CommandRequest;
    baseRevision: number;
    reply?: { revision: number; value: JsonValue };
    resolve(value: JsonValue): void;
    reject(error: Error): void;
  };

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

  function sameEpoch(commit: Pick<BrowserCommit, "epoch">) {
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
      if (!command.reply || command.reply.revision > current.revision) continue;
      pending.delete(id);
      command.resolve(checked<JsonValue>(command.reply.value));
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

  /** The revision of a commit this window already holds, read without decoding it: each commit reaches the window
   *  twice when it answers the window's own command, once as a commit and once in the reply. */
  function heldRevision(input: JsonInput): number | null {
    if (!current || !isJsonObject(input) || input.epoch !== current.epoch) return null;
    const revision = input.revision;

    return v.is(NUMBER, revision) && Number.isSafeInteger(revision) && revision >= 0 && revision <= current.revision ? revision : null;
  }

  function acceptCommit(input: BrowserCommit) {
    if (terminalError || heldRevision(checked<JsonInput>(input)) !== null) return;
    let commit: BrowserCommit;

    try {
      commit = timed("Bay.client decodeCommit", () => decodeBrowserCommit(checked<JsonInput>(input), current));
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
    // The window's store takes the commit here, and its subscribers run.
    timed("Bay.client applyCommit", notify, { revision: commit.revision });
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
        const commit = decodeBrowserCommit(checked<JsonInput>(input), current);

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
      .catch((cause: unknown) => {
        snapshotInFlight = false;

        if (terminalError) return;

        // The runtime is between coordinators (a window opening as another replaces it): ask again once it's back.
        if (errorCode(cause) === "not_ready" && snapshotRetries < SNAPSHOT_RETRIES) {
          snapshotRetries++;
          setTimeout(requestSnapshot, SNAPSHOT_RETRY_MS);

          return;
        }

        const reason = cause instanceof Error ? `: ${cause.message}` : "";
        fail(cause instanceof BrowserClientError ? cause : new BrowserClientError("snapshot_failed", `browser runtime snapshot failed${reason}`));
      });
  }

  function receiveReply(command: Pending, input: ClientReply) {
    if (terminalError || !pending.has(command.request.requestId)) return;

    // SAFETY: the checks above established this shape.

    try {
      const reply = record(checked<JsonInput>(input));

      if (
        Object.keys(reply).some((key) => !["clientId", "requestId", "commit", "value"].includes(key)) ||
        reply.clientId !== clientId ||
        reply.requestId !== command.request.requestId
      )
        invalid();

      if (!validateBrowserCommandResult(command.request.command, reply.value)) invalid();
      const stamp = record(reply.commit);
      let revision = heldRevision(stamp);
      let commit: BrowserCommit | null = null;

      if (revision === null && Object.hasOwn(stamp, "state")) {
        commit = timed("Bay.client decodeReply", () => decodeBrowserCommit(stamp, current));

        if (!sameEpoch(commit)) return;
        revision = commit.revision;
      } else if (revision === null) {
        // Only the revision: its commit reaches this window as a commit (or in a snapshot), and settle() waits for it.
        const { epoch, revision: named } = stamp;

        if (Object.keys(stamp).length !== 2 || !v.is(TEXT, epoch) || !epoch || !v.is(NUMBER, named) || !Number.isSafeInteger(named) || named < 0) invalid();

        if (!sameEpoch({ epoch })) return;
        revision = named;
      }

      if (revision < command.baseRevision) invalid();
      command.reply = { revision, value: copyJson(checked<JsonInput>(reply.value)) };

      if (commit) acceptValidatedCommit(commit);
      settle();
    } catch {
      fail(new BrowserClientError("invalid_protocol", "invalid browser runtime command reply"));
    }
  }

  async function dispatch<C extends BrowserCommand>(input: C): Promise<BrowserCommandValue<C>> {
    if (terminalError) throw terminalError;
    // Detach immediately, before bootstrap or resync waits can yield to callers.
    // Optional undefined fields have the same representation as a JSON request.
    // SAFETY: the command is a plain object of JSON fields, which copyJson keeps as it is.
    const command = copyJson(input, undefined, new Set(), 0, true) as BrowserCommand;

    while (status !== "ready") {
      if (terminalError) throw terminalError;
      await availability.promise;
    }

    if (terminalError) throw terminalError;

    if (!Number.isSafeInteger(++nextRequestId)) throw new BrowserClientError("invalid_protocol", "browser request sequence is exhausted");
    const request: CommandRequest = Object.freeze({ epoch: current!.epoch, clientId, requestId: nextRequestId, command });
    // A command's whole time, as its caller waits for it: sent, run by the coordinator, and its commit applied here.
    const started = spanStart();

    return new Promise<BrowserCommandValue<C>>((resolve, reject) => {
      const item: Pending = {
        request,
        baseRevision: current!.revision,
        resolve: (value) => {
          span(`Bay.command ${command.method}`, started);
          // SAFETY: the runtime answers with the command's own value, which the reply's validation checked.
          resolve(value as BrowserCommandValue<C>);
        },
        reject: (error) => {
          span(`Bay.command ${command.method}`, started, { failed: true });
          reject(error);
        },
      };

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
          (cause: unknown) => {
            if (terminalError || !pending.has(request.requestId)) return;

            if (v.is(v.object({ code: v.string() }), cause) && cause.code === "stale_epoch") {
              fail(new BrowserClientError("epoch_changed", "browser runtime changed; the command outcome is uncertain"));

              return;
            }

            pending.delete(request.requestId);
            reject(cause);
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
  } catch (error) {
    // The transport closed before this client subscribed; its error names why.
    const code = errorCode(error);
    let cause = "";

    if (error instanceof Error) cause = v.is(v.string(), code) ? ` (${code}): ${error.message}` : `: ${error.message}`;
    fail(new BrowserClientError("transport_closed", `browser runtime transport could not connect${cause}`));
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
