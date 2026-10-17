import { useState } from "react";

/**
 * Calls `reset` in the render where `key` changes (not on mount): state that belongs to one request, folder or
 * query starts over with the next, and no frame shows it left over from the last (as an effect resetting it would).
 * React's "adjusting some state when a prop changes", for a reset that's all it does.
 */
export function useResetOn(key: unknown, reset: () => void) {
  const [last, setLast] = useState(key);
  if (!Object.is(key, last)) {
    setLast(key);
    reset();
  }
}
