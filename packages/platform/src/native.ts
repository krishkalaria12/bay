// Metro replaces this file on Windows. Keep Expo out of the Windows dependency graph.
export { requireNativeModule, requireOptionalNativeModule, requireNativeViewManager } from "expo-modules-core";
export type EventSubscription = { remove(): void };

/** The native macOS facade remains synchronous where its existing ABI allows it. */
export function nativeSnapshot<T>(_module: string, _method: string, _args: readonly unknown[], fallback: () => T): T {
  return fallback();
}

export function nativeDocumentWrite(_name: string, _contents: string | null, fallback: () => void): void {
  fallback();
}
