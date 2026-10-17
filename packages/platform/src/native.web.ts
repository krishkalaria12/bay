import type { ComponentType } from "react";
import { bindNativeModule, getNativeTransport, getNativeHostInfo, decodeNativeResult, NativeBridgeError, type EventSubscription } from "./nativeBridge";
export { getNativeHostInfo, readNativeSnapshot, invokeNative, subscribeNativeEvent } from "./nativeBridge";
export type { EventSubscription } from "./nativeBridge";

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
  views.set(name, component as ComponentType<object>);
  return { remove() { if (views.get(name) === component) views.delete(name); } };
}
export function requireNativeViewManager<P extends object>(name: string): ComponentType<P> {
  const view = views.get(name);
  if (!view) throw new NativeBridgeError("missing_view", `Bay has no registered DOM adapter for ${name}`);
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
      const acknowledged = current && typeof current === "object" && !Array.isArray(current)
        && (Object.prototype.hasOwnProperty.call(current, name) ? current[name] : null) === optimistic.value;
      if (!optimistic.pending && acknowledged) documentWrites.delete(name);
      else return optimistic.value as T;
    }
  }
  const indexed: Record<string, { field: string; missing: null | boolean }> = {
    "BayShell.readDocument": { field: "documents", missing: null },
    "BayApp.launchEnvironment": { field: "environment", missing: null },
    "BaySystem.fileExists": { field: "files", missing: false },
  };
  const source = indexed[`${module}.${method}`];
  if (source) {
    const values = snapshots?.[source.field];
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new NativeBridgeError("snapshot_unavailable", `Missing native snapshot ${module}.${source.field}`);
    const key = String(args[0]);
    return (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : source.missing) as T;
  }
  if (args.length === 0 && snapshots && Object.prototype.hasOwnProperty.call(snapshots, method)) return snapshots[method] as T;
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
  resetDocumentState();
  const transport = getNativeTransport();
  const sequence = ++documentSequence;
  if (!documentWrites.has(name)) {
    const documents = transport.getHostInfo().snapshots?.BayShell?.documents;
    if (documents && typeof documents === "object" && !Array.isArray(documents)) {
      const value = Object.prototype.hasOwnProperty.call(documents, name) ? documents[name] : null;
      if (typeof value === "string" || value === null) documentCommitted.set(name, value);
    }
  }
  documentWrites.set(name, { value: contents, sequence, pending: true });
  const method = contents === null ? "removeDocument" : "writeDocument";
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
      const code = error instanceof NativeBridgeError ? error.code : "transport_error";
      console.error(`Native document ${method} failed for ${name}: ${code}`);
    }
  });
  documentQueues.set(name, operation);
  void operation.then(() => { if (documentQueues.get(name) === operation) documentQueues.delete(name); });
}
