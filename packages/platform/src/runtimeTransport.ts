import { decodeNativeResult, NativeBridgeError } from "./nativeBridge.ts";

export type RuntimeCommit<State> = Readonly<{ epoch: string; revision: number; state: State }>;
export type RuntimeRequest<Command> = Readonly<{ epoch: string; clientId: string; requestId: number; originWindowId?: string; command: Command }>;
export type RuntimeReply<State, Value> = Readonly<{ clientId: string; requestId: number; commit: RuntimeCommit<State>; value: Value }>;
export type RuntimeResolution<Value> =
  | Readonly<{ epoch: string; revision: number; value: Value }>
  | Readonly<{ epoch: string; error: { code: string; message: string } }>;
export type RuntimeBootstrap<State> =
  | Readonly<{ version: 1; role: "window"; epoch: string; clientId: string; windowId: string }>
  | Readonly<{ version: 1; role: "coordinator"; epoch: string; clientId: string; recoveryState?: State }>;

type Event<Args extends unknown[]> = { addListener(listener: (...args: Args) => void): number };
type ConnectionErrors = Event<[]> & { removeListener(id: number): boolean | void };
export interface MojoAppRuntimeRemote {
  connect(client: unknown): Promise<{ resultJson: string }>;
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
  $: { bindNewPipeAndPassRemote(): unknown; close(): void };
}
type Common<State> = { bootstrap: RuntimeBootstrap<State>; subscribeClose(listener: (error: NativeBridgeError) => void): () => void; dispose(): void };
export type WindowRuntimeTransport<State, Command, Value> = Common<State> & {
  bootstrap: Extract<RuntimeBootstrap<State>, { role: "window" }>;
  getSnapshot(): Promise<RuntimeCommit<State>>;
  dispatch(request: RuntimeRequest<Command>): Promise<RuntimeReply<State, Value>>;
  subscribeCommits(listener: (commit: RuntimeCommit<State>) => void): () => void;
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
const invalid = (message: string): never => {
  throw new NativeBridgeError("invalid_runtime_message", message);
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid("Expected a runtime object");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    invalid("Unexpected runtime fields");
}
function id(value: unknown): string {
  // oxlint-disable-next-line no-control-regex -- Protocol identities reject ASCII whitespace and control characters.
  if (typeof value !== "string" || !value || value.length > 128 || /[\x00-\x20\x7f]/.test(value)) return invalid("Invalid runtime identity");
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid("Invalid runtime revision");
  return value;
}
function freezeJSON(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object" || !value || depth > 128 || ancestors.has(value)) return invalid("Runtime value is not JSON data");
  if (!Array.isArray(value)) object(value);
  ancestors.add(value);
  try {
    const copied = Array.isArray(value)
      ? Array.from(value, (item) => freezeJSON(item, ancestors, depth + 1))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJSON(item, ancestors, depth + 1)]));
    return Object.freeze(copied);
  } finally {
    ancestors.delete(value);
  }
}
function bounded(json: unknown, limit: number): string {
  if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > limit) return invalid("Runtime message is too large or is not JSON text");
  return json;
}
function fromJSON(json: unknown, limit: number): unknown {
  try {
    return freezeJSON(JSON.parse(bounded(json, limit)));
  } catch (error) {
    if (error instanceof NativeBridgeError) throw error;
    return invalid("Runtime message is not valid JSON");
  }
}
function toJSON(value: unknown, limit: number): string {
  return bounded(JSON.stringify(freezeJSON(value)), limit);
}
function commitFrom<State>(value: unknown, epoch: string): RuntimeCommit<State> {
  const commit = object(value);
  exact(commit, ["epoch", "revision", "state"]);
  if (id(commit.epoch) !== epoch) throw new NativeBridgeError("stale_epoch", "Browser runtime epoch changed");
  revision(commit.revision);
  object(commit.state);
  return commit as unknown as RuntimeCommit<State>;
}
function requestFrom<Command>(value: unknown, epoch: string, fromNative = false): RuntimeRequest<Command> {
  const request = object(value);
  exact(request, ["epoch", "clientId", "requestId", "command"], fromNative ? ["originWindowId"] : []);
  if (id(request.epoch) !== epoch) throw new NativeBridgeError("stale_epoch", "Browser runtime epoch changed");
  id(request.clientId);
  if (Object.hasOwn(request, "originWindowId")) id(request.originWindowId);
  if (revision(request.requestId) < 1) invalid("Runtime request id must be positive");
  object(request.command);
  return request as unknown as RuntimeRequest<Command>;
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
  const commitListeners = new Set<{ listener: (commit: RuntimeCommit<State>) => void }>();
  let commandListener: ((token: string, request: RuntimeRequest<Command>) => void) | null = null;
  const queuedCommands: [string, RuntimeRequest<Command>][] = [];
  const tokens = new Set<string>();
  const earlyEvents: (() => void)[] = [];
  let latestCommit: RuntimeCommit<State> | null = null;
  const pending = new Set<{ reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
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
  function invoke(call: () => Promise<{ resultJson: string }>, limit = COMMIT_LIMIT + 1024, deadline = timeoutMs): Promise<unknown> {
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
              resolve(freezeJSON(decodeNativeResult(bounded(response.resultJson, limit))));
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
        const commit = commitFrom<State>(fromJSON(json, COMMIT_LIMIT), bootstrap!.epoch);
        if (!latestCommit || commit.revision > latestCommit.revision) latestCommit = commit;
        // oxlint-disable-next-line unicorn/no-useless-spread -- Snapshot subscribers so changes during delivery affect the next commit.
        for (const { listener } of [...commitListeners]) listener(commit);
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
        const request = requestFrom<Command>(fromJSON(json, REQUEST_LIMIT), bootstrap!.epoch, true);
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
      exact(value, ["version", "role", "epoch", "clientId"], ["recoveryState"]);
      if (expectedWindowId !== undefined) invalid("Coordinator cannot claim a window identity");
      if (value.recoveryState !== undefined) object(value.recoveryState);
    }
    bootstrap = value as unknown as RuntimeBootstrap<State>;
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
            close(error as NativeBridgeError);
            throw error;
          }
        },
        async dispatch(input) {
          active();
          const request = requestFrom<Command>(freezeJSON(input), assigned.epoch);
          if (request.clientId !== assigned.clientId) invalid("Browser runtime client identity mismatch");
          const json = toJSON(request, REQUEST_LIMIT);
          const value = await invoke(() => remote.dispatch(json));
          try {
            const reply = object(value);
            exact(reply, ["clientId", "requestId", "commit", "value"]);
            if (reply.clientId !== assigned.clientId || reply.requestId !== request.requestId) invalid("Runtime reply identity mismatch");
            commitFrom<State>(reply.commit, assigned.epoch);
            return reply as unknown as RuntimeReply<State, Value>;
          } catch (error) {
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
    return {
      ...common,
      bootstrap: assigned,
      async publish(commit) {
        active();
        commitFrom<State>(commit, assigned.epoch);
        const json = toJSON(commit, COMMIT_LIMIT);
        await ack(() => remote.publish(json));
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
          if (typeof error.message !== "string" || !error.message || error.message.length > 16384) invalid("Invalid coordinator command error");
        } else {
          exact(value, ["epoch", "revision", "value"]);
          revision(value.revision);
        }
        const json = toJSON(reply, REQUEST_LIMIT);
        try {
          await ack(() => remote.resolve(token, json));
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
