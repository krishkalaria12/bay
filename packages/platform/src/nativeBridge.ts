import * as v from "valibot";
import { checked, isJsonObject, type JsonInput, type JsonObject, type JsonValue } from "./json.ts";
import { nativeContracts } from "./nativeContracts.ts";

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export type EventSubscription = { remove(): void };

export type NativeHostOS = "macos" | "windows" | "linux";

export type NativeHostInfo = {
  contractVersion: number;
  platform: NativeHostOS;
  modules: readonly string[];
  views: readonly string[];
  optionalMethods?: readonly string[];
  constants: Readonly<Record<string, Readonly<Record<string, JSONValue>>>>;
  snapshots?: Readonly<Record<string, Readonly<Record<string, JSONValue>>>>;
};

/** getHostInfo reads a local snapshot populated before the application imports. */
export interface NativeTransport {
  getHostInfo(): NativeHostInfo;
  invoke(module: string, method: string, argsJSON: string): Promise<string>;
  subscribe(module: string, event: string, listener: (payload: JsonValue) => void): EventSubscription;
  dispose?(): void;
}

export const NATIVE_CONTRACT_VERSION = 2;

type Contract = {
  methods: Record<string, { optional: boolean; minArgs: number; maxArgs: number }>;
  events: readonly string[];
};

const contracts: Record<string, Contract> = nativeContracts.modules;
const record = (value: JsonInput): value is JsonObject => isJsonObject(value);

export class NativeBridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "NativeBridgeError";
  }
}

export function validateNativeHostInfo(value: JsonInput): asserts value is JsonInput & NativeHostInfo {
  if (!record(value)) throw new NativeBridgeError("invalid_host_info", "Bay native host info must be an object");

  if (value.contractVersion !== NATIVE_CONTRACT_VERSION) {
    throw new NativeBridgeError(
      "contract_mismatch",
      `Bay native contract mismatch: JavaScript ${NATIVE_CONTRACT_VERSION}, native ${String(value.contractVersion)}. Rebuild Bay from this checkout.`,
    );
  }

  if (!["macos", "windows", "linux"].includes(String(value.platform)))
    throw new NativeBridgeError("unsupported_platform", "Bay's native host must identify a supported desktop OS");

  for (const name of ["modules", "views", "optionalMethods"] as const) {
    const list = value[name];

    if (name === "optionalMethods" && list === undefined) continue;

    if (!Array.isArray(list) || list.some((item) => !v.is(v.string(), item)) || new Set(list).size !== list.length) {
      throw new NativeBridgeError("invalid_host_info", `Bay native ${name} catalog is invalid`);
    }
  }

  for (const name of ["constants", "snapshots"] as const) {
    const map = value[name];

    if (name === "snapshots" && map === undefined) continue;

    if (!record(map) || Object.values(map).some((module) => !record(module)))
      throw new NativeBridgeError("invalid_host_info", `Bay native ${name} map is invalid`);
  }
}

/** Native errors are transport envelopes. An engine's domain Result stays inside value. */
export function decodeNativeResult(json: string): JsonValue {
  let result: JsonInput;

  try {
    result = checked<JsonInput>(JSON.parse(json));
  } catch {
    throw new NativeBridgeError("invalid_result", "Bay native result is not valid JSON");
  }

  const envelope = checked<JsonInput>(result);

  if (!record(envelope) || "error" in envelope === "value" in envelope) throw new NativeBridgeError("invalid_result", "Invalid Bay native result envelope");

  if ("error" in envelope) {
    const detail = envelope.error;

    const fields = checked<JsonInput>(detail);

    if (!isJsonObject(fields) || !v.is(v.string(), fields.code) || !v.is(v.string(), fields.message))
      throw new NativeBridgeError("invalid_result", "Invalid Bay native error envelope");
    throw new NativeBridgeError(fields.code, fields.message);
  }

  return checked<JsonValue>(envelope.value);
}

let installed: NativeTransport | null = null;

export function installNativeTransport(transport: NativeTransport): EventSubscription {
  validateNativeHostInfo(checked<JsonInput>(transport.getHostInfo()));

  if (installed) throw new NativeBridgeError("already_initialized", "Bay's native transport is already initialized");
  installed = transport;
  let removed = false;

  return {
    remove() {
      if (removed) return;
      removed = true;

      if (installed === transport) installed = null;
      transport.dispose?.();
    },
  };
}

export function getNativeTransport(): NativeTransport {
  if (!installed) throw new NativeBridgeError("not_initialized", "Initialize Bay's native transport before importing the application");

  return installed;
}

export function getNativeHostInfo(): NativeHostInfo {
  const info = getNativeTransport().getHostInfo();
  validateNativeHostInfo(checked<JsonInput>(info));

  return info;
}

/** Cached host state, never a synchronous native invocation. Missing state stays distinguishable. */
export function readNativeSnapshot<T>(module: string, key: string): T | undefined {
  const values = getNativeHostInfo().snapshots?.[module];

  // SAFETY: the checks above established this shape.
  return values && Object.prototype.hasOwnProperty.call(values, key) ? (values[key] as T) : undefined;
}

export async function invokeNative<T = unknown>(module: string, method: string, args: readonly unknown[] = []): Promise<T> {
  // SAFETY: the checks above established this shape.
  return decodeNativeResult(await getNativeTransport().invoke(module, method, JSON.stringify(args))) as T;
}

export function subscribeNativeEvent(module: string, event: string, listener: (payload: JsonValue) => void): EventSubscription {
  return getNativeTransport().subscribe(module, event, listener);
}

export function bindNativeModule<T>(transport: NativeTransport, name: string): T | null {
  const info = transport.getHostInfo();
  validateNativeHostInfo(checked<JsonInput>(info));

  if (!info.modules.includes(name)) return null;
  const contract = contracts[name];

  if (!contract) throw new NativeBridgeError("unknown_module", `Unknown Bay native module ${name}`);
  const functions = new Map<string, unknown>();

  // SAFETY: the checks above established this shape.
  return new Proxy(Object.create(null) as object, {
    get(_target, key) {
      if (key === "then" || !v.is(v.string(), key)) return undefined;
      const hostInfo = transport.getHostInfo();
      validateNativeHostInfo(checked<JsonInput>(hostInfo));

      if (key === "contractVersion") return hostInfo.contractVersion;
      const constants = hostInfo.constants[name];

      if (constants && Object.prototype.hasOwnProperty.call(constants, key)) return constants[key];

      if (key === "addListener") {
        if (!functions.has(key))
          functions.set(key, (event: string, listener: (payload: JsonValue) => void) => {
            if (!contract.events.includes(event)) throw new NativeBridgeError("unknown_event", `Unknown native event ${name}.${event}`);

            return transport.subscribe(name, event, listener);
          });

        return functions.get(key);
      }

      const method = contract.methods[key];

      if (!method || (method.optional && !hostInfo.optionalMethods?.includes(`${name}.${key}`))) return undefined;

      if (!functions.has(key))
        functions.set(key, async (...args: unknown[]) => {
          if (args.length < method.minArgs || (method.maxArgs >= 0 && args.length > method.maxArgs))
            throw new NativeBridgeError("invalid_arguments", `Invalid argument count for ${name}.${key}`);

          return decodeNativeResult(await transport.invoke(name, key, JSON.stringify(args)));
        });

      return functions.get(key);
    },
  }) as T;
}
