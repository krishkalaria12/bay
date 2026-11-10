import { useState } from "react";

/** True from the render `value` is first true onwards: a component that's only needed once something has happened. */
export function useLatched(value: boolean): boolean {
  const [latched, setLatched] = useState(value);

  if (value && !latched) setLatched(true);

  return latched || value;
}
