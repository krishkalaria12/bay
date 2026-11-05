import { useEffect, useState } from "react";

/** `on`, and for `ms` after it turns off: for what has an animation of its own on the way out. */
export function useTrailing(on: boolean, ms: number): boolean {
  const [trailing, setTrailing] = useState(on);
  useEffect(() => {
    if (on) {
      setTrailing(true);
      return;
    }
    const timer = setTimeout(() => setTrailing(false), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on || trailing;
}
