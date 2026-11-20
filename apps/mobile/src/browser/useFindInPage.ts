import type { Tab } from "@bay/engine";
import * as Effect from "effect/Effect";
import { useEffect, useRef, useState } from "react";
import { Keyboard } from "react-native";
import * as v from "valibot";

import { useScopedWork } from "@/effect/react";
import { FIND_CLEAR_SCRIPT, findScript, findStepScript, type FindResult } from "@/pagescripts/find";
import { read, sendPageScript } from "./pageScripts";

/** Typing pauses this long before the page is searched. */
const SEARCH_DELAY_MS = 150;

/** What the page says it found. */
const findResultSchema = v.object({ count: v.number(), index: v.number() });

/** The count, and the query it was found for. */
type Found = FindResult & { query: string };

/** Find on page for the active tab. `pageKey` names the document; a new one ends the search. */
export function useFindInPage(view: Tab | undefined, pageKey: string) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The count belongs to the query it was found for, so a stale one never shows next to new text.
  const [result, setResult] = useState<Found | null>(null);
  // Each search and step runs for one page and one query: new text or a new page interrupts it, so only the newest
  // can update the count.
  const work = useScopedWork(`${pageKey}\n${query}`);
  // The search waiting for typing to pause, run early when Return is pressed.
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    setOpen(false);
    setQuery("");
    setResult(null);
  }, [pageKey]);

  useEffect(() => {
    if (!open || !view) return;

    if (!query) {
      setResult(null);
      sendPageScript(view, FIND_CLEAR_SCRIPT);

      return;
    }

    const search = () => {
      pending.current = null;
      clearTimeout(timer);
      work.run(
        read(view, findScript(query), findResultSchema).pipe(
          // A page that can't be searched has nothing to show for this text.
          Effect.catch(() => Effect.succeed({ count: 0, index: -1 })),
          Effect.flatMap((found) => Effect.sync(() => setResult({ ...found, query }))),
        ),
      );
    };

    const timer = setTimeout(search, SEARCH_DELAY_MS);
    pending.current = search;

    return () => {
      clearTimeout(timer);
      pending.current = null;
    };
    // The work belongs to the page and the query, which these already name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      work.run(
        read(view, findStepScript(step), findResultSchema).pipe(
          // A step the page didn't answer leaves the count as it was.
          Effect.flatMap((found) => Effect.sync(() => setResult({ ...found, query }))),
          Effect.catch(() => Effect.void),
        ),
      );
    },
    done(): void {
      Keyboard.dismiss();
      setOpen(false);
      setQuery("");
      setResult(null);

      if (view) sendPageScript(view, FIND_CLEAR_SCRIPT);
    },
  };
}
