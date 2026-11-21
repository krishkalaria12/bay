import * as v from "valibot";
import { decodeNativeResult, NativeBridgeError } from "./nativeBridge.ts";
import { checked, isJsonObject, isNumber, isString, jsonKind, type JsonInput, type JsonObject, type JsonValue } from "./json.ts";
import { sizeOf, span, spanStart } from "./profiling.ts";

export type RuntimeCommit<State> = Readonly<{ epoch: string; revision: number; state: State }>;

/** A commit carrying only the state's top-level fields that changed since the revision before it. It applies only
 *  on top of that revision; the fields it leaves out are that revision's. */
export type RuntimeDelta<State> = Readonly<{ epoch: string; revision: number; state: Partial<State>; partial: true }>;

export type RuntimeRequest<Command> = Readonly<{ epoch: string; clientId: string; requestId: number; originWindowId?: string; command: Command }>;

/** A command's reply names the commit that carries its result. The browser may leave that commit's state out: the
 *  window gets the commit itself as a commit, or in a snapshot. */
export type RuntimeReply<State, Value> = Readonly<{
  clientId: string;
  requestId: number;
  commit: RuntimeCommit<State> | Readonly<{ epoch: string; revision: number }>;
  value: Value;
}>;

export type RuntimeResolution<Value> =
  | Readonly<{ epoch: string; revision: number; value: Value }>
  | Readonly<{ epoch: string; error: { code: string; message: string } }>;

export type RuntimeBootstrap<State> =
  | Readonly<{ version: 1; role: "window"; epoch: string; clientId: string; windowId: string }>
  | Readonly<{ version: 1; role: "coordinator"; epoch: string; clientId: string; recoveryState?: State; partialCommits?: true }>;

type Event<Args extends unknown[]> = { addListener(listener: (...args: Args) => void): number };

type ConnectionErrors = Event<[]> & { removeListener(id: number): boolean | void };

export interface MojoAppRuntimeRemote {
  connect<Client>(client: Client): Promise<{ resultJson: string }>;
  getSnapshot(): Promise<{ resultJson: string }>;
  dispatch(requestJson: string): Promise<{ resultJson: string }>;
  publish(commitJson: string): Promise<{ resultJson: string }>;
  resolve(token: string, replyJson: string): Promise<{ resultJson: string }>;
  ready(): Promise<{ resultJson: string }>;
  onConnectionError: ConnectionErrors;
  $: { close(): void };
}

export interface MojoAppRuntimeClientRouter {
  onCommit: Event<[commitJson: string]>;
  onCommand: Event<[token: string, requestJson: string]>;
  onRuntimeClosed: Event<[code: string]>;
  onConnectionError: ConnectionErrors;
  removeListener(id: number): boolean | void;
  $: { bindNewPipeAndPassRemote(): MojoAppRuntimeRemote; close(): void };
}

type Common<State> = { bootstrap: RuntimeBootstrap<State>; subscribeClose(listener: (error: NativeBridgeError) => void): () => void; dispose(): void };

export type WindowRuntimeTransport<State, Command, Value> = Common<State> & {
  bootstrap: Extract<RuntimeBootstrap<State>, { role: "window" }>;
  getSnapshot(): Promise<RuntimeCommit<State>>;
  dispatch(request: RuntimeRequest<Command>): Promise<RuntimeReply<State, Value>>;
  subscribeCommits(listener: (commit: RuntimeCommit<State> | RuntimeDelta<State>) => void): () => void;
};

export type CoordinatorRuntimeTransport<State, Command, Value> = Common<State> & {
  bootstrap: Extract<RuntimeBootstrap<State>, { role: "coordinator" }>;
  publish(commit: RuntimeCommit<State>): Promise<void>;
  resolve(token: string, reply: RuntimeResolution<Value>): Promise<void>;
  announceReady(): Promise<void>;
  subscribeCommands(listener: (token: string, request: RuntimeRequest<Command>) => void): () => void;
};

export type AppRuntimeTransport<State, Command, Value> = WindowRuntimeTransport<State, Command, Value> | CoordinatorRuntimeTransport<State, Command, Value>;

const COMMIT_LIMIT = 16 * 1024 * 1024;
const REQUEST_LIMIT = 1024 * 1024;

const invalid: (message: string) => never = (message) => {
  throw new NativeBridgeError("invalid_runtime_message", message);
};

/** A runtime message's object: JSON's own shape, not an array. */
function object<T>(value: T): JsonObject {
  const fields = checked<JsonInput>(value);

  if (!isJsonObject(fields) || Object.getPrototypeOf(fields) !== Object.prototype) return invalid("Expected a runtime object");

  return fields;
}

function exact(value: JsonObject, required: string[], optional: string[] = []) {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    invalid("Unexpected runtime fields");
}

function id<T>(value: T): string {
  const text = checked<JsonInput>(value);

  // oxlint-disable-next-line no-control-regex -- Protocol identities reject ASCII whitespace and control characters.
  if (!isString(text) || !text || text.length > 128 || /[\x00-\x20\x7f]/.test(text)) return invalid("Invalid runtime identity");

  return text;
}

function revision<T>(value: T): number {
  const count = checked<JsonInput>(value);

  if (!isNumber(count) || !Number.isSafeInteger(count) || count < 0) return invalid("Invalid runtime revision");

  return count;
}

const TEXT = v.string();
const MAXIMUM_DEPTH = 128;

const notJSON = () => invalid("Runtime value is not JSON data");

/** A detached, frozen copy of JSON data, for values a caller still holds and could change. */
function freezeJSON<T>(value: T, ancestors = new Set<object>(), depth = 0): JsonValue {
  const json = checked<JsonInput>(value);
  const kind = jsonKind(json);

  if (kind === "leaf") return json!;
  const node = checked<object>(json);

  if (kind === null || depth > MAXIMUM_DEPTH || ancestors.has(node)) return notJSON();
  ancestors.add(node);

  try {
    const copied = Array.isArray(json)
      ? Array.from(json, (item) => freezeJSON(item, ancestors, depth + 1))
      : Object.fromEntries(Object.entries(checked<JsonObject>(json)).map(([key, item]) => [key, freezeJSON(item, ancestors, depth + 1)]));

    // SAFETY: a frozen copy still holds the JSON values it was copied from.
    return Object.freeze(copied) as JsonValue;
  } finally {
    ancestors.delete(node);
  }
}

// Deeply frozen nodes already checked, with how many object levels lie below each. The coordinator's projection
// shares unchanged nodes between commits, so a commit checks only the paths that changed.
const verified = new WeakMap<object, number>();

/** Checks that `value` is JSON data a runtime message may carry, as freezeJSON does, without copying it. Returns
 *  how many object levels lie below it (-1 for a leaf). */
function checkJSON<T>(value: T, ancestors = new Set<object>(), depth = 0): number {
  const json = checked<JsonInput>(value);
  const kind = jsonKind(json);

  if (kind === "leaf") return -1;

  const node = checked<object>(json);

  if (kind === null || ancestors.has(node)) return notJSON();
  const known = verified.get(node);

  if (known !== undefined) {
    if (depth + known > MAXIMUM_DEPTH) notJSON();

    return known;
  }

  if (depth > MAXIMUM_DEPTH) return notJSON();
  ancestors.add(node);
  let height = 0;
  let deep = Object.isFrozen(node);

  try {
    const items = Array.isArray(json) ? json : Object.values(checked<JsonObject>(json));

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const below = checkJSON(item, ancestors, depth + 1);

      if (below < 0) continue;
      height = Math.max(height, below + 1);
      deep &&= verified.has(checked<object>(item));
    }
  } finally {
    ancestors.delete(node);
  }

  if (deep) verified.set(node, height);

  return height;
}

/** Freezes freshly parsed JSON where it lies: nothing else holds it, so it needs no copy. */
function freezeParsed(json: JsonValue, depth = 0): JsonValue {
  if (Object(json) !== json) return json;

  if (depth > MAXIMUM_DEPTH) return notJSON();
  const items = Array.isArray(json) ? json : Object.values(checked<JsonObject>(json));

  for (let index = 0; index < items.length; index++) freezeParsed(items[index]!, depth + 1);
  Object.freeze(json);

  return json;
}

/** Whether `text` takes at most `limit` bytes as UTF-8. A UTF-16 unit takes one to three bytes, so most messages
 *  answer without being encoded. */
function fitsUtf8(text: string, limit: number): boolean {
  if (text.length > limit) return false;

  if (text.length * 3 <= limit) return true;

  return new TextEncoder().encode(text).byteLength <= limit;
}

function bounded<T>(json: T, limit: number): string {
  const text = checked<JsonInput>(json);

  if (!v.is(TEXT, text) || !fitsUtf8(text, limit)) return invalid("Runtime message is too large or is not JSON text");

  return text;
}

function fromJSON<T>(json: T, limit: number): JsonValue {
  let parsed: JsonValue;

  try {
    parsed = JSON.parse(bounded(json, limit));
  } catch (error) {
    if (error instanceof NativeBridgeError) throw error;

    return invalid("Runtime message is not valid JSON");
  }

  return freezeParsed(parsed);
}

function toJSON<T>(value: T, limit: number): string {
  checkJSON(value);

  return bounded(JSON.stringify(value), limit);
}

function commitFrom<State>(value: JsonInput, epoch: string): RuntimeCommit<State> {
  const commit = object(value);
  exact(commit, ["epoch", "revision", "state"]);
  stamped(commit, epoch);

  // SAFETY: the checks above established this shape.
  return checked<RuntimeCommit<State>>(commit);
}

/** A commit to a window: the whole state, or a delta of it. */
function windowCommitFrom<State>(value: JsonInput, epoch: string): RuntimeCommit<State> | RuntimeDelta<State> {
  const commit = object(value);
  exact(commit, ["epoch", "revision", "state"], ["partial"]);

  if (Object.hasOwn(commit, "partial") && commit.partial !== true) invalid("Invalid runtime delta");
  stamped(commit, epoch);

  // SAFETY: the checks above established this shape.
  return checked<RuntimeCommit<State> | RuntimeDelta<State>>(commit);
}

/** The delta from `previous` to `next`: the top-level fields whose values aren't the same objects. Null when `next`
 *  doesn't follow `previous`, or drops one of its fields. */
function deltaOf<State>(previous: RuntimeCommit<State> | null, next: RuntimeCommit<State>): RuntimeDelta<State> | null {
  if (!previous || previous.epoch !== next.epoch || next.revision !== previous.revision + 1) return null;
  const before = checked<JsonObject>(previous.state);
  const after = checked<JsonObject>(next.state);
  const changed: JsonObject = {};

  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) return null;

  for (const key of Object.keys(after)) if (!Object.hasOwn(before, key) || before[key] !== after[key]) changed[key] = after[key]!;

  return { epoch: next.epoch, revision: next.revision, state: checked<Partial<State>>(changed), partial: true };
}

function stamped(commit: JsonObject, epoch: string) {
  if (id(commit.epoch) !== epoch) throw new NativeBridgeError("stale_epoch", "Browser runtime epoch changed");
  revision(commit.revision);
  object(commit.state);
}

function requestFrom<Command>(value: JsonInput, epoch: string, fromNative = false): RuntimeRequest<Command> {
  const request = object(value);
  exact(request, ["epoch", "clientId", "requestId", "command"], fromNative ? ["originWindowId"] : []);

  if (id(request.epoch) !== epoch) throw new NativeBridgeError("stale_epoch", "Browser runtime epoch changed");
  id(request.clientId);

  if (Object.hasOwn(request, "originWindowId")) id(request.originWindowId);

  if (revision(request.requestId) < 1) invalid("Runtime request id must be positive");
  object(request.command);

  // SAFETY: the checks above established this shape.
  return checked<RuntimeRequest<Command>>(request);
}

/** Only browser-created Mojo endpoints may be passed here. No window messages,
 * URL parameters or renderer-provided role can grant coordinator authority.
 */
export async function createAppRuntimeTransport<State, Command, Value>({
  remote,
  client,
  expectedRole,
  expectedWindowId,
  timeoutMs = 30000,
  bootstrapTimeoutMs = 15000,
}: {
  remote: MojoAppRuntimeRemote;
  client: MojoAppRuntimeClientRouter;
  expectedRole: "window" | "coordinator";
  expectedWindowId?: string;
  timeoutMs?: number;
  bootstrapTimeoutMs?: number;
}): Promise<AppRuntimeTransport<State, Command, Value>> {
  let bootstrap: RuntimeBootstrap<State> | null = null;
  let failure: NativeBridgeError | null = null;
  const removers: (() => void)[] = [];
  const closeListeners = new Set<{ listener: (error: NativeBridgeError) => void }>();
  const commitListeners = new Set<{ listener: (commit: RuntimeCommit<State> | RuntimeDelta<State>) => void }>();
  let commandListener: ((token: string, request: RuntimeRequest<Command>) => void) | null = null;
  const queuedCommands: [string, RuntimeRequest<Command>][] = [];
  const tokens = new Set<string>();
  const earlyEvents: (() => void)[] = [];
  let latestCommit: RuntimeCommit<State> | RuntimeDelta<State> | null = null;
  const pending = new Set<{ reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  const active = () => {
    if (failure) throw failure;
  };

  const register = (remove: () => void) => {
    if (failure) remove();
    else removers.push(remove);
  };

  function close(error: NativeBridgeError) {
    if (failure) return;
    failure = error;

    for (const operation of pending) {
      clearTimeout(operation.timer);
      operation.reject(error);
    }

    pending.clear();

    for (const remove of removers.splice(0)) {
      try {
        remove();
      } catch {}
    }

    for (const endpoint of [client, remote]) {
      try {
        endpoint.$.close();
      } catch {}
    }

    queuedCommands.length = 0;
    earlyEvents.length = 0;
    tokens.clear();
    commitListeners.clear();
    commandListener = null;

    // oxlint-disable-next-line unicorn/no-useless-spread -- Notify the subscribers present at close even if callbacks unsubscribe others.
    for (const { listener } of [...closeListeners]) {
      try {
        listener(error);
      } catch (cause) {
        console.error("[runtime] close subscriber failed", cause);
      }
    }

    closeListeners.clear();
  }

  function invoke(call: () => Promise<{ resultJson: string }>, limit = COMMIT_LIMIT + 1024, deadline = timeoutMs): Promise<JsonValue> {
    try {
      active();
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const operation = {
        reject,
        timer: setTimeout(
          () => close(new NativeBridgeError("runtime_timeout", "Browser runtime request timed out; mutation outcomes may be uncertain")),
          deadline,
        ),
      };

      pending.add(operation);
      void Promise.resolve()
        .then(() => {
          active();

          return call();
        })
        .then(
          (response) => {
            if (!pending.delete(operation)) return;
            clearTimeout(operation.timer);

            try {
              active();
              resolve(freezeParsed(decodeNativeResult(bounded(response.resultJson, limit))));
            } catch (error) {
              if (error instanceof NativeBridgeError && !["invalid_result", "invalid_runtime_message", "stale_epoch", "runtime_closed"].includes(error.code))
                reject(error);
              else {
                const problem = error instanceof NativeBridgeError ? error : new NativeBridgeError("invalid_runtime_message", "Invalid runtime reply");
                reject(problem);
                close(problem);
              }
            }
          },
          () => close(new NativeBridgeError("transport_closed", "Browser runtime Mojo pipe closed")),
        );
    });
  }

  function event(run: () => void) {
    if (failure) return;

    if (!bootstrap) {
      if (earlyEvents.length >= 64) close(new NativeBridgeError("invalid_runtime_message", "Too many runtime bootstrap events"));
      else earlyEvents.push(run);

      return;
    }

    try {
      run();
    } catch (error) {
      close(error instanceof NativeBridgeError ? error : new NativeBridgeError("invalid_runtime_message", "Invalid browser runtime event"));
    }
  }

  const subscribeClose = (listener: (error: NativeBridgeError) => void) => {
    if (failure) {
      listener(failure);

      return () => {};
    }

    const entry = { listener };
    closeListeners.add(entry);

    return () => {
      closeListeners.delete(entry);
    };
  };

  try {
    if (![timeoutMs, bootstrapTimeoutMs].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) invalid("Invalid runtime deadline");

    for (const endpoint of [remote, client]) {
      const listener = endpoint.onConnectionError.addListener(() => close(new NativeBridgeError("transport_closed", "Browser runtime Mojo pipe closed")));
      register(() => {
        endpoint.onConnectionError.removeListener(listener);
      });
      active();
    }

    const onCommit = client.onCommit.addListener((json) =>
      event(() => {
        if (bootstrap!.role !== "window") invalid("Coordinator received a window commit");
        const decoding = spanStart();
        const commit = windowCommitFrom<State>(fromJSON(json, COMMIT_LIMIT), bootstrap!.epoch);
        span("Bay.runtime decodeCommit", decoding, { bytes: sizeOf(json), revision: commit.revision });

        if (!latestCommit || commit.revision > latestCommit.revision) latestCommit = commit;
        const delivering = spanStart();

        // oxlint-disable-next-line unicorn/no-useless-spread -- Snapshot subscribers so changes during delivery affect the next commit.
        for (const { listener } of [...commitListeners]) listener(commit);
        span("Bay.runtime deliverCommit", delivering, { revision: commit.revision });
      }),
    );

    register(() => {
      client.removeListener(onCommit);
    });

    const onCommand = client.onCommand.addListener((token, json) =>
      event(() => {
        if (bootstrap!.role !== "coordinator") invalid("Window received a coordinator command");
        id(token);

        if (tokens.has(token) || tokens.size >= 64) invalid("Invalid coordinator command token");
        // Only native dispatch can stamp the originating window's identity.
        const decoding = spanStart();
        const request = requestFrom<Command>(fromJSON(json, REQUEST_LIMIT), bootstrap!.epoch, true);
        span("Bay.runtime decodeCommand", decoding, { bytes: sizeOf(json) });
        tokens.add(token);

        if (commandListener) commandListener(token, request);
        else queuedCommands.push([token, request]);
      }),
    );

    register(() => {
      client.removeListener(onCommand);
    });

    const onClosed = client.onRuntimeClosed.addListener((code) => {
      try {
        close(new NativeBridgeError(id(code), "Browser runtime closed; pending mutation outcomes may be uncertain"));
      } catch {
        close(new NativeBridgeError("invalid_runtime_message", "Invalid runtime close code"));
      }
    });

    register(() => {
      client.removeListener(onClosed);
    });
    const value = object(await invoke(() => remote.connect(client.$.bindNewPipeAndPassRemote()), COMMIT_LIMIT + 1024, bootstrapTimeoutMs));

    if (value.version !== 1 || value.role !== expectedRole || !["window", "coordinator"].includes(String(value.role))) invalid("Browser runtime role mismatch");
    id(value.epoch);
    id(value.clientId);

    if (value.role === "window") {
      exact(value, ["version", "role", "epoch", "clientId", "windowId"]);
      id(value.windowId);

      if (expectedWindowId !== undefined && value.windowId !== expectedWindowId) invalid("Browser runtime window identity mismatch");
    } else {
      exact(value, ["version", "role", "epoch", "clientId"], ["recoveryState", "partialCommits"]);

      if (expectedWindowId !== undefined) invalid("Coordinator cannot claim a window identity");

      if (Object.hasOwn(value, "partialCommits") && value.partialCommits !== true) invalid("Invalid runtime capability");

      if (value.recoveryState !== undefined) object(value.recoveryState);
    }

    // SAFETY: the checks above established this shape.
    bootstrap = checked<RuntimeBootstrap<State>>(value);

    for (const queued of earlyEvents.splice(0)) event(queued);
    active();
    const common = { bootstrap, subscribeClose, dispose: () => close(new NativeBridgeError("transport_closed", "Browser runtime transport closed")) };

    const ack = async (call: () => Promise<{ resultJson: string }>) => {
      if ((await invoke(call, REQUEST_LIMIT)) !== null) {
        const error = new NativeBridgeError("invalid_runtime_message", "Invalid runtime acknowledgment");
        close(error);
        throw error;
      }
    };

    if (bootstrap.role === "window") {
      const assigned = bootstrap;

      return {
        ...common,
        bootstrap: assigned,
        async getSnapshot() {
          const value = await invoke(() => remote.getSnapshot());

          try {
            return commitFrom<State>(value, assigned.epoch);
          } catch (error) {
            // SAFETY: the checks above established this shape.
            close(error as NativeBridgeError);
            throw error;
          }
        },
        async dispatch(input) {
          active();
          const request = requestFrom<Command>(freezeJSON(input), assigned.epoch);

          if (request.clientId !== assigned.clientId) invalid("Browser runtime client identity mismatch");
          const encoding = spanStart();
          const json = toJSON(request, REQUEST_LIMIT);
          span("Bay.runtime encodeCommand", encoding, { bytes: sizeOf(json) });
          const waiting = spanStart();
          const value = await invoke(() => remote.dispatch(json));
          span("Bay.runtime awaitReply", waiting);

          try {
            const reply = object(value);
            exact(reply, ["clientId", "requestId", "commit", "value"]);

            if (reply.clientId !== assigned.clientId || reply.requestId !== request.requestId) invalid("Runtime reply identity mismatch");
            const stamp = object(reply.commit);

            if (Object.hasOwn(stamp, "state")) commitFrom<State>(stamp, assigned.epoch);
            else {
              exact(stamp, ["epoch", "revision"]);

              if (id(stamp.epoch) !== assigned.epoch) throw new NativeBridgeError("stale_epoch", "Browser runtime epoch changed");
              revision(stamp.revision);
            }

            // SAFETY: the checks above established this shape.
            return checked<RuntimeReply<State, Value>>(reply);
          } catch (error) {
            // SAFETY: the checks above established this shape.
            close(error as NativeBridgeError);
            throw error;
          }
        },
        subscribeCommits(listener) {
          active();
          const entry = { listener };
          commitListeners.add(entry);

          if (latestCommit) listener(latestCommit);

          return () => {
            commitListeners.delete(entry);
          };
        },
      };
    }

    const assigned = bootstrap;
    // The commit the browser last accepted: an engine that takes deltas gets only what changed since it.
    let accepted: RuntimeCommit<State> | null = null;

    return {
      ...common,
      bootstrap: assigned,
      async publish(commit) {
        active();
        const encoding = spanStart();
        commitFrom<State>(checked<JsonInput>(commit), assigned.epoch);
        const delta = assigned.partialCommits ? deltaOf(accepted, commit) : null;
        const json = toJSON(delta ?? commit, COMMIT_LIMIT);
        span("Bay.runtime encodeCommit", encoding, { bytes: sizeOf(json), revision: commit.revision, partial: delta !== null });
        const publishing = spanStart();
        await ack(() => remote.publish(json));
        accepted = commit;
        span("Bay.runtime awaitPublish", publishing, { revision: commit.revision });
      },
      async resolve(token, reply) {
        active();

        if (!tokens.has(token)) invalid("Unknown coordinator command token");
        const value = object(reply);

        if (value.epoch !== assigned.epoch) invalid("Coordinator reply epoch mismatch");

        if ("error" in value) {
          exact(value, ["epoch", "error"]);
          const error = object(value.error);
          exact(error, ["code", "message"]);
          id(error.code);

          if (!v.is(v.string(), error.message) || !error.message || error.message.length > 16384) invalid("Invalid coordinator command error");
        } else {
          exact(value, ["epoch", "revision", "value"]);
          revision(value.revision);
        }

        const json = toJSON(reply, REQUEST_LIMIT);
        const resolving = spanStart();

        try {
          await ack(() => remote.resolve(token, json));
          span("Bay.runtime awaitResolve", resolving, { bytes: sizeOf(json) });
        } finally {
          tokens.delete(token);
        }
      },
      announceReady() {
        return ack(() => remote.ready());
      },
      subscribeCommands(listener) {
        active();

        if (commandListener) throw new NativeBridgeError("already_subscribed", "Coordinator already has a command handler");
        commandListener = listener;

        try {
          for (const [token, request] of queuedCommands.splice(0)) listener(token, request);
        } catch (error) {
          close(new NativeBridgeError("coordinator_failed", "Coordinator command handler failed"));
          throw error;
        }

        return () => {
          if (commandListener === listener) commandListener = null;
        };
      },
    };
  } catch (error) {
    const problem = error instanceof NativeBridgeError ? error : new NativeBridgeError("transport_closed", "Browser runtime failed to connect");
    close(problem);
    throw problem;
  }
}
