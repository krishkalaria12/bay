import { useCallback, useLayoutEffect, useRef } from "react";

/** One function for the component's lifetime that calls the latest callback. A SwiftUI button whose handler changes
 * while a page loads (every progress update re-renders the bar) can drop a tap that lands during the update. */
export function useStableCallback<Args extends unknown[]>(callback: ((...args: Args) => void) | undefined): (...args: Args) => void {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });

  return useCallback((...args: Args) => latest.current?.(...args), []);
}
