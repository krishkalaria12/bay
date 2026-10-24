import type { BrowserState } from "../store/browser";

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type DataKey = { [K in keyof BrowserState]: BrowserState[K] extends (...args: never[]) => unknown ? never : K }[keyof BrowserState];

// This is the coordinator's complete state, including private windows. A native
// broker must filter it for each window before sending it across renderer IPC.
export type BrowserProjection = DeepReadonly<Pick<BrowserState, DataKey>>;

/** Copies immutable store nodes once. Never freeze nodes belonging to the store. */
export function createBrowserProjector() {
  const copies = new WeakMap<object, object>();
  const visiting = new Set<object>();
  function copy(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null) throw new Error("browser state contains a non-JSON value");
    if (visiting.has(value)) throw new Error("browser state contains a cycle");
    const existing = copies.get(value);
    if (existing) return existing;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error("browser state contains a non-JSON object");
    visiting.add(value);
    try {
      const result = Array.isArray(value)
        ? value.map((item) => (item === undefined ? null : copy(item)))
        : Object.fromEntries(
            Object.entries(value)
              .filter(([, item]) => item !== undefined)
              .map(([key, item]) => [key, copy(item)]),
          );
      Object.freeze(result);
      copies.set(value, result);
      return result;
    } finally {
      visiting.delete(value);
    }
  }
  return (state: BrowserState): BrowserProjection => {
    const data = Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== "function"));
    return copy(data) as BrowserProjection;
  };
}
