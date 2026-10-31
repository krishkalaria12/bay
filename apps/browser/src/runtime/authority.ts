import { withSidebarUndoWindow } from "../store/sidebarUndo";
import { createBrowserStore, type BrowserStore } from "../store/browser";
import { createBrowserProjector, type BrowserProjection } from "./projection";
import type { LocationCommandEffects } from "./locationCommands";
import { executeBrowserCommand, parseBrowserCommand, type BrowserCommand } from "./userCommands";
export type { BrowserCommand } from "./userCommands";

export type BrowserCommit = Readonly<{ epoch: string; revision: number; state: BrowserProjection }>;
export type CommandRequest = Readonly<{ epoch: string; clientId: string; requestId: number; originWindowId?: string; command: BrowserCommand }>;
export type CommandReply = Readonly<{ clientId: string; requestId: number; commit: BrowserCommit; value: unknown }>;

type AuthorityErrorCode = "invalid_request" | "stale_epoch" | "request_conflict" | "request_expired" | "closed";
export class AuthorityError extends Error {
  readonly code: AuthorityErrorCode;
  constructor(code: AuthorityErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AuthorityError";
  }
}

const invalid = (message: string): never => {
  throw new AuthorityError("invalid_request", message);
};
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
/** In-process authority only. It does not authenticate renderer client identities. */
export function createBrowserAuthority({
  epoch,
  store = createBrowserStore(),
  effects,
  executeAsync,
}: {
  epoch: string;
  store?: BrowserStore;
  effects?: LocationCommandEffects;
  executeAsync?: (command: BrowserCommand, isActive: () => boolean) => Promise<unknown>;
}) {
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
        // oxlint-disable-next-line no-useless-spread -- callbacks can change the next delivery's subscribers
        for (const listener of [...listeners]) {
          try {
            listener(next);
          } catch (error) {
            console.error("[runtime] commit subscriber failed", error);
          }
        }
      }
    } finally {
      notifying = false;
    }
  }
  const unsubscribe = store.subscribe(() => {
    if (!executing) publish();
  });

  function enqueue<T>(apply: () => T) {
    const reply = queue.then(() => {
      if (closed) throw new AuthorityError("closed", "authority is closed");
      executing = true;
      let value: T;
      try {
        value = apply();
      } finally {
        executing = false;
        publish();
      }
      return Object.freeze({ commit, value });
    });
    queue = reply.then(
      () => {},
      () => {},
    );
    return reply;
  }

  function dispatch(input: unknown): Promise<CommandReply> {
    try {
      if (closed) throw new AuthorityError("closed", "authority is closed");
      const request = record(input);
      keys(request, ["epoch", "clientId", "requestId", "command", "originWindowId"]);
      if (request.epoch !== epoch) throw new AuthorityError("stale_epoch", "authority epoch has changed");
      const clientId = text(request.clientId);
      const requestId = request.requestId;
      if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId < 1) return invalid("request id must be a positive safe integer");
      // Native stamps this after validating the renderer envelope and origin policy.
      const originWindowId = request.originWindowId === undefined ? undefined : text(request.originWindowId);
      const command = parseBrowserCommand(request.command);
      const fingerprint = JSON.stringify({ command, originWindowId });
      let client = clients.get(clientId);
      if (!client) {
        client = { lastRequestId: 0, replies: new Map() };
        clients.set(clientId, client);
      }
      const previous = client.replies.get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AuthorityError("request_conflict", "request id was reused for another command");
        return previous.reply;
      }
      if (requestId <= client.lastRequestId) throw new AuthorityError("request_expired", "request is too old to replay");
      client.lastRequestId = requestId;
      // External service work may await network/native IO. It retains request
      // deduplication, while ordinary reducer commands continue through queue.
      const action =
        command.method === "serviceAction"
          ? enqueue(() => {
              if (!executeAsync) throw new AuthorityError("invalid_request", "Service owner is unavailable");
              // Service reducers record undo synchronously, before their first await.
              return withSidebarUndoWindow(originWindowId, () => executeAsync(command, () => !closed));
            }).then(async ({ value }) => {
              const result = await value;
              return enqueue(() => result);
            })
          : enqueue(() => withSidebarUndoWindow(originWindowId, () => executeBrowserCommand(store, command, effects)));
      const reply = action.then(({ commit, value }) => Object.freeze({ clientId, requestId, commit, value }));
      client.replies.set(requestId, { fingerprint, reply });
      // Retain recent replies, but never re-execute an evicted request. Sequence
      // numbers are scoped to a browser-authenticated client and epoch.
      const acceptedClient = client;
      void reply
        .finally(() => {
          while (acceptedClient.replies.size > 128) acceptedClient.replies.delete(acceptedClient.replies.keys().next().value!);
        })
        .catch(() => {});
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
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch,
    // Browser-authenticated events share command ordering, without extending
    // the renderer's command vocabulary or allowing user-supplied adoption IDs.
    dispatchNative(apply: (store: BrowserStore) => string | null) {
      return enqueue(() => apply(store));
    },
    close() {
      closed = true;
      unsubscribe();
      listeners.clear();
      clients.clear();
    },
  };
}
