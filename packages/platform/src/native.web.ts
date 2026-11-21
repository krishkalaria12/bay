import * as v from "valibot";
import type { ComponentType } from "react";
import { bindNativeModule, getNativeTransport, getNativeHostInfo, decodeNativeResult, NativeBridgeError, type EventSubscription } from "./nativeBridge";
import { isJsonObject } from "./json.ts";

export { getNativeHostInfo, readNativeSnapshot, invokeNative, subscribeNativeEvent } from "./nativeBridge";

export type { EventSubscription } from "./nativeBridge";

export function nativeRandomUUID(_fallback: () => string): string {
  return globalThis.crypto.randomUUID();
}

export function requireOptionalNativeModule<T = unknown>(name: string): T | null {
  return bindNativeModule<T>(getNativeTransport(), name);
}

export function requireNativeModule<T = unknown>(name: string): T {
  const module = requireOptionalNativeModule<T>(name);

  if (!module) throw new NativeBridgeError("missing_module", `Required native module ${name} is unavailable in this Bay host`);

  return module;
}

const views = new Map<string, ComponentType<object>>();

/** Native view packages register their DOM adapters before loading the shared application. */
export function registerNativeWebView<P extends object>(name: string, component: ComponentType<P>): EventSubscription {
  if (views.has(name)) throw new NativeBridgeError("duplicate_view", `Web view ${name} is already registered`);
  // SAFETY: the checks above established this shape.
  views.set(name, component as ComponentType<object>);

  return {
    remove() {
      if (views.get(name) === component) views.delete(name);
    },
  };
}

export function requireNativeViewManager<P extends object>(name: string): ComponentType<P> {
  const view = views.get(name);

  if (!view) throw new NativeBridgeError("missing_view", `Bay has no registered DOM adapter for ${name}`);

  // SAFETY: the checks above established this shape.
  return view as ComponentType<P>;
}

/** Local host snapshots preserve existing read-only facades without synchronous IPC. */
export function nativeSnapshot<T>(module: string, method: string, args: readonly unknown[], _fallback: () => T): T {
  resetDocumentState();
  const snapshots = getNativeHostInfo().snapshots?.[module];

  if (module === "BayShell" && method === "readDocument") {
    const name = String(args[0]);
    const optimistic = documentWrites.get(name);

    if (optimistic) {
      const current = snapshots?.documents;

      const acknowledged =
        current &&
        isJsonObject(current) &&
        !Array.isArray(current) &&
        (Object.prototype.hasOwnProperty.call(current, name) ? current[name] : null) === optimistic.value;

      if (!optimistic.pending && acknowledged) documentWrites.delete(name);
      else {
        // SAFETY: the checks above established this shape.
        return optimistic.value as T;
      }
    }
  }

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- The table is a lookup by name, so its open shape is the point.
  const indexed: Record<string, { field: string; missing: null | boolean }> = {
    "BayShell.readDocument": { field: "documents", missing: null },
    "BayApp.launchEnvironment": { field: "environment", missing: null },
  };

  const source = indexed[`${module}.${method}`];

  if (source) {
    const values = snapshots?.[source.field];

    if (!values || !isJsonObject(values)) throw new NativeBridgeError("snapshot_unavailable", `Missing native snapshot ${module}.${source.field}`);
    const key = String(args[0]);

    // SAFETY: the checks above established this shape.
    return (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : source.missing) as T;
  }

  // SAFETY: the checks above established this shape.
  if (args.length === 0 && snapshots && Object.prototype.hasOwnProperty.call(snapshots, method)) {
    // SAFETY: the checks above established this shape.
    return snapshots[method] as T;
  }

  throw new NativeBridgeError("snapshot_unavailable", `Missing native snapshot ${module}.${method}`);
}

type DocumentWrite = { value: string | null; sequence: number; pending: boolean };

const documentWrites = new Map<string, DocumentWrite>();
const documentQueues = new Map<string, Promise<void>>();
const documentCommitted = new Map<string, string | null>();
let documentTransport: ReturnType<typeof getNativeTransport> | null = null;
let documentSequence = 0;

function resetDocumentState(): void {
  const transport = getNativeTransport();

  if (documentTransport === transport) return;
  documentTransport = transport;
  documentWrites.clear();
  documentQueues.clear();
  documentCommitted.clear();
}

/** Optimistic reads and per-document ordering match the existing fire-and-forget facade. */
export function nativeDocumentWrite(name: string, contents: string | null, _fallback: () => void): void {
  const method = contents === null ? "removeDocument" : "writeDocument";
  void queueDocumentWrite(name, contents, method).catch((error) => {
    const code = error instanceof NativeBridgeError ? error.code : "transport_error";
    console.error(`Native document ${method} failed for ${name}: ${code}`);
  });
}

/** Acknowledged saves share the queue with optimistic writes and removals. */
export function nativeDocumentSave(name: string, contents: string, _fallback: () => Promise<void>): Promise<void> {
  return queueDocumentWrite(name, contents, "saveDocument");
}

function queueDocumentWrite(name: string, contents: string | null, method: string): Promise<void> {
  resetDocumentState();
  const transport = getNativeTransport();
  const sequence = ++documentSequence;

  if (!documentWrites.has(name)) {
    const documents = transport.getHostInfo().snapshots?.BayShell?.documents;

    if (documents && isJsonObject(documents)) {
      const value = Object.prototype.hasOwnProperty.call(documents, name) ? documents[name] : null;

      if (v.is(v.string(), value) || value === null) documentCommitted.set(name, value);
    }
  }

  documentWrites.set(name, { value: contents, sequence, pending: true });
  const args = contents === null ? [name] : [name, contents];
  const previous = documentQueues.get(name) ?? Promise.resolve();

  const operation = previous.then(async () => {
    try {
      decodeNativeResult(await transport.invoke("BayShell", method, JSON.stringify(args)));

      if (transport === documentTransport) documentCommitted.set(name, contents);
      const pending = documentWrites.get(name);

      if (pending?.sequence === sequence && transport === documentTransport) pending.pending = false;
    } catch (error) {
      if (documentWrites.get(name)?.sequence === sequence && transport === documentTransport) {
        if (documentCommitted.has(name)) documentWrites.set(name, { value: documentCommitted.get(name)!, sequence, pending: false });
        else documentWrites.delete(name);
      }

      throw error;
    }
  });

  // A rejected save must reach its caller without poisoning later writes.
  const settled = operation.catch(() => {});
  documentQueues.set(name, settled);
  void settled.then(() => {
    if (documentQueues.get(name) === settled) documentQueues.delete(name);
  });

  return operation;
}
