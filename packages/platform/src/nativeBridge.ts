import { nativeContracts } from "./nativeContracts.ts";

export type EventSubscription = { remove(): void };
export type WindowsBridge = {
  contractVersion: number;
  modules: readonly string[];
  views: readonly string[];
  constantsJSON: string;
  invoke(module: string, method: string, argsJSON: string): Promise<string>;
  invokeSync(module: string, method: string, argsJSON: string): string;
};

export const NATIVE_CONTRACT_VERSION = 1;

type Contract = { methods: Record<string, { async: boolean; optional: boolean }>; events: readonly string[] };
const contracts: Record<string, Contract> = nativeContracts.modules;

/** A version mismatch is never an optional capability. A stale binary must be rebuilt. */
export function validateWindowsBridge(bridge: WindowsBridge): void {
  if (bridge.contractVersion !== NATIVE_CONTRACT_VERSION) {
    throw new Error(`Bay Windows native contract mismatch: JavaScript ${NATIVE_CONTRACT_VERSION}, native ${bridge.contractVersion}. Rebuild the Windows app.`);
  }
  if (!Array.isArray(bridge.modules) || !Array.isArray(bridge.views)) {
    throw new Error("Bay Windows native catalog is invalid. Rebuild the Windows app.");
  }
}

/** Native returns {value: JSON} for success or {error: {code, message}} for failure. */
export function decodeNativeResult(json: string): unknown {
  const result: unknown = JSON.parse(json);
  if (!result || typeof result !== "object") throw new Error("Invalid Bay Windows native result");
  if ("error" in result) {
    const detail = result.error as { code?: string; message?: string };
    const error = new Error(detail?.message ?? "Bay Windows native call failed");
    Object.assign(error, { code: detail?.code ?? "native_error" });
    throw error;
  }
  if (!("value" in result)) throw new Error("Bay Windows native result has no value");
  return result.value;
}

export function bindWindowsModule<T>(
  bridge: WindowsBridge,
  name: string,
  subscribe: (event: string, listener: (...args: unknown[]) => void) => EventSubscription,
): T | null {
  validateWindowsBridge(bridge);
  if (!bridge.modules.includes(name)) return null;
  const contract = contracts[name];
  if (!contract) throw new Error(`Unknown Bay native module ${name}`);
  const constants: Record<string, Record<string, unknown>> = JSON.parse(bridge.constantsJSON);
  const ownConstants = constants[name] ?? {};
  const functions = new Map<string, unknown>();
  return new Proxy(Object.create(null) as object, {
    get(_target, key) {
      if (key === "then" || typeof key !== "string") return undefined;
      if (key === "contractVersion") return bridge.contractVersion;
      if (Object.prototype.hasOwnProperty.call(ownConstants, key)) return ownConstants[key];
      if (functions.has(key)) return functions.get(key);
      if (key === "addListener") {
        const listen = (event: string, listener: (...args: unknown[]) => void) => {
          if (!contract.events.includes(event)) throw new Error(`Unknown native event ${name}.${event}`);
          return subscribe(`${name}.${event}`, listener);
        };
        functions.set(key, listen);
        return listen;
      }
      const method = contract.methods[key];
      if (!method) return undefined;
      const call = (...args: unknown[]) => {
        const json = JSON.stringify(args);
        return method.async
          ? bridge.invoke(name, key, json).then(decodeNativeResult)
          : decodeNativeResult(bridge.invokeSync(name, key, json));
      };
      functions.set(key, call);
      return call;
    },
  }) as T;
}
