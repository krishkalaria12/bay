import * as v from "valibot";
import { checked } from "../lib/checked";
import { isJsonObject, type JsonValue } from "../lib/json";
import type { BrowserState } from "../store/browserStore";

type OneLess = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];

/** Read-only down to a few levels: deep enough for the store's own shape, shallow enough to type cheaply. */
export type DeepReadonly<T, D extends number = 8> = D extends 0 ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K], OneLess[D]> } : T;

type DataKey = { [K in keyof BrowserState]: BrowserState[K] extends (...args: never[]) => void ? never : K }[keyof BrowserState];

// This is the coordinator's complete state, including private windows. A native
// broker must filter it for each window before sending it across renderer IPC.
export type BrowserProjection = DeepReadonly<Pick<BrowserState, DataKey>>;

/** A window as the projection holds it: named, so a spread of it doesn't deepen the type afresh. */
export type ProjectionWindow = BrowserProjection["windows"][string];

/** Copies immutable store nodes once. Never freeze nodes belonging to the store. */
export function createBrowserProjector() {
  const copies = new WeakMap<object, JsonValue>();
  const visiting = new Set<object>();

  function copy(value: JsonValue): JsonValue {
    if (value === null || v.is(v.string(), value) || v.is(v.boolean(), value)) return value;

    if (v.is(v.number(), value) && Number.isFinite(value)) return value;

    if (!Array.isArray(value) && !isJsonObject(value)) throw new Error("browser state contains a non-JSON value");

    const node = value;

    if (visiting.has(node)) throw new Error("browser state contains a cycle");
    const existing = copies.get(node);

    if (existing) return existing;

    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error("browser state contains a non-JSON object");
    visiting.add(node);

    try {
      const result = Array.isArray(value)
        ? value.map((item) => (item === undefined ? null : copy(item)))
        : Object.fromEntries(
            Object.entries(value)
              .filter(([, item]) => item !== undefined)
              .map(([key, item]) => [key, copy(item)]),
          );

      Object.freeze(result);
      copies.set(node, result);

      return result;
    } finally {
      visiting.delete(node);
    }
  }

  return (state: BrowserState): BrowserProjection => {
    const data = Object.fromEntries(Object.entries(state).filter(([, value]) => !v.is(v.function_(), value)));

    // SAFETY: the store holds JSON data, which the copy above checks as it goes.
    return checked<BrowserProjection>(copy(checked<JsonValue>(data)));
  };
}
