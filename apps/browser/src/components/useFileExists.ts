import { useEffect, useState } from "react";
import { fileExists } from "@bay/shell";

/** Reads a file's current native state, discarding results for an old path or unmounted row. */
export function useFileExists(path: string | undefined, enabled = true): boolean | null {
  const [result, setResult] = useState<{ path: string; exists: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    if (!enabled || !path) {
      setResult(null);
      return () => {
        live = false;
      };
    }
    setResult(null);
    void fileExists(path).then(
      (value) => {
        if (live) setResult({ path, exists: value });
      },
      () => {
        if (live) setResult(null);
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, path]);

  return enabled && result && result.path === path ? result.exists : null;
}
