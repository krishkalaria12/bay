import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A stable function that always runs the latest `fn`: for handlers created once (a PanResponder's, a native
 * listener's) that read the latest props. React 19.2's `useEffectEvent`, which our React (19.1) lacks; like it, call
 * it from events and effects, never during render.
 */
export function useEffectEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  // Before any layout effect or event can call it.
  useInsertionEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
