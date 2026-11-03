import { useEffect } from "react";
import { useEffectEvent } from "../../lib/useEffectEvent";
import { perfProbeEnabled } from "../../lib/perfProbe";

export type OmniboxDriver = {
  type(text: string): void;
  clear(): void;
  key(key: string, mods?: { metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean }): void;
  submit(): void;
  state(): unknown;
  measure(): Promise<{ x: number; y: number; width: number; height: number }>;
};

const drivers = new Map<string, OmniboxDriver>();

export type OmniboxTrace = { bar: string; typed: string; heard: number; committed: number };
let trace: OmniboxTrace[] | null = null;

export function traceOmnibox(entry: OmniboxTrace) {
  if (__DEV__ && trace) trace.push(entry);
}

export const omniboxDrivers = {
  get: (id: string) => drivers.get(id),
  ids: () => [...drivers.keys()],
  trace: {
    start: () => void (trace = []),
    stop: () => {
      const out = trace ?? [];
      trace = null;
      return out;
    },
  },
};

export function useOmniboxDriver(id: string, driver: OmniboxDriver) {
  const current = useEffectEvent(() => driver);
  useEffect(() => {
    if (!__DEV__ && !perfProbeEnabled) return;
    const proxy: OmniboxDriver = {
      type: (text) => current().type(text),
      clear: () => current().clear(),
      key: (key, mods) => current().key(key, mods),
      submit: () => current().submit(),
      state: () => current().state(),
      measure: () => current().measure(),
    };
    drivers.set(id, proxy);
    return () => {
      if (drivers.get(id) === proxy) drivers.delete(id);
    };
  }, [id, current]);
}
