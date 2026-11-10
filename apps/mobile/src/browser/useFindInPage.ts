import { runPageScript, type Tab } from "@bay/engine";
import { useEffect, useRef, useState } from "react";
import { Keyboard } from "react-native";

import { FIND_CLEAR_SCRIPT, findScript, findStepScript, type FindResult } from "@/pagescripts/find";

/** Typing pauses this long before the page is searched. */
const SEARCH_DELAY_MS = 150;

/** Find on page for the active tab. `pageKey` names the document; a new one ends the search. */
export function useFindInPage(view: Tab | undefined, pageKey: string) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The count belongs to the query it was found for, so a stale one never shows next to new text.
  const [result, setResult] = useState<(FindResult & { query: string }) | null>(null);
  // Only the latest search or step may update the count.
  const request = useRef(0);
  // The search waiting for typing to pause, run early when Return is pressed.
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    request.current++;
    setOpen(false);
    setQuery("");
    setResult(null);
  }, [pageKey]);

  useEffect(() => {
    if (!open || !view) return;
    const id = ++request.current;

    if (!query) {
      setResult(null);
      void runPageScript(view, FIND_CLEAR_SCRIPT).catch(() => {});

      return;
    }

    const search = () => {
      pending.current = null;
      clearTimeout(timer);
      runPageScript<FindResult>(view, findScript(query)).then(
        (found) => id === request.current && setResult({ ...found, query }),
        () => id === request.current && setResult({ count: 0, index: -1, query }),
      );
    };

    const timer = setTimeout(search, SEARCH_DELAY_MS);
    pending.current = search;

    return () => {
      clearTimeout(timer);
      pending.current = null;
    };
  }, [open, query, view]);

  const current = result?.query === query ? result : null;

  return {
    open,
    query,
    count: current?.count ?? null,
    index: current?.index ?? -1,
    start(): void {
      setQuery("");
      setResult(null);
      setOpen(true);
    },
    change: setQuery,
    step(step: 1 | -1): void {
      // Return right after typing searches now rather than stepping through the old matches.
      if (pending.current) return pending.current();

      if (!view || !current?.count) return;
      const id = ++request.current;
      runPageScript<FindResult>(view, findStepScript(step)).then(
        (found) => id === request.current && setResult({ ...found, query }),
        () => {},
      );
    },
    done(): void {
      request.current++;
      Keyboard.dismiss();
      setOpen(false);
      setQuery("");
      setResult(null);

      if (view) void runPageScript(view, FIND_CLEAR_SCRIPT).catch(() => {});
    },
  };
}
