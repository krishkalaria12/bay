import { createContext, useContext, useEffect, useRef, useState } from "react";

import type { MessageKey } from "@/i18n";

import { LINKS, PHRASES, type Step } from "./flow";
import type { FirstRunColors } from "./palette";
import type { Tilt } from "./useTilt";

/** What every part of the welcome reads: the page on screen and the pages' own life. */
export interface Run {
  step: Step;
  colors: FirstRunColors;
  tilt: Tilt;
  reduced: boolean;
  /** The private page's glasses are on: the page is night. */
  privateOn: boolean;
  togglePrivate: () => void;
  /** The field page: what the field is typing, what landed in each way, and the way just lit. */
  typed: string;
  landed: [string, string, string];
  lit: number | null;
  tapField: () => void;
  /** The links page: the tab in front, and a link on its way in from another app. */
  linkShown: number;
  linkComing: number | null;
  linkLanding: boolean;
  /** A finger on the name: its jelly, counted. */
  pokes: number;
  poke: () => void;
}

export const RunContext = createContext<Run | null>(null);

export function useRun(): Run {
  const run = useContext(RunContext);

  if (!run) throw new Error("useRun is for the welcome's own parts");

  return run;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The field types a phrase, and the phrase lands in its way: Search, Go to site or Your tabs. A tap on the field types
 * the next one at once. Phrases are message keys, read through `words`.
 */
export function useTyping(active: boolean, reduced: boolean, words: (key: MessageKey) => string) {
  const [typed, setTyped] = useState("");
  const [landed, setLanded] = useState<[string, string, string]>(["", "", ""]);
  const [lit, setLit] = useState<number | null>(null);
  const [restart, setRestart] = useState(0);
  const phrase = useRef(0);
  const wordsRef = useRef(words);
  wordsRef.current = words;

  useEffect(() => {
    if (!active) return;
    setTyped("");

    if (reduced) {
      setLanded([wordsRef.current(PHRASES[0].landed), wordsRef.current(PHRASES[1].landed), wordsRef.current(PHRASES[2].landed)]);

      return;
    }

    let cancelled = false;

    void (async () => {
      if (restart === 0) await wait(500);

      while (!cancelled) {
        const { typed: key, way, landed: landedKey } = PHRASES[phrase.current % PHRASES.length]!;
        phrase.current += 1;
        const text = wordsRef.current(key);

        for (let i = 1; i <= text.length && !cancelled; i++) {
          setTyped(text.slice(0, i));
          await wait(42);
        }

        await wait(380);

        if (cancelled) return;
        setTyped("");
        setLanded((now) => {
          const next: [string, string, string] = [...now];
          next[way] = wordsRef.current(landedKey);

          return next;
        });
        setLit(way);
        await wait(450);
        setLit(null);
        await wait(900);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, reduced, restart]);

  return { typed, landed, lit, tap: () => setRestart((count) => count + 1) };
}

/** A link comes in from another app every couple of seconds and becomes the tab in front. */
export function useLinks(active: boolean, reduced: boolean) {
  const [shown, setShown] = useState(0);
  const [coming, setComing] = useState<number | null>(null);
  const [landing, setLanding] = useState(false);

  useEffect(() => {
    if (!active || reduced) return;
    let cancelled = false;

    void (async () => {
      let current = 0;

      while (!cancelled) {
        await wait(1100);

        if (cancelled) return;
        const next = (current + 1) % LINKS.length;
        setComing(next);
        setLanding(false);
        await wait(900);

        if (cancelled) return;
        setLanding(true);
        await wait(380);

        if (cancelled) return;
        current = next;
        setShown(next);
        setComing(null);
        setLanding(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, reduced]);

  return { shown, coming, landing };
}
