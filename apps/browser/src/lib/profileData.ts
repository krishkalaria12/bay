import { deleteProfileData } from "@bay/nncore";
import { useBrowser, type BrowserStore } from "../store/browser";

// A deleted profile's engine data goes once its web views have closed. What can't be deleted stays queued
// (in session.json) and is tried again at the next launch.
const CLOSE_DELAY_MS = 1500;

export function createProfileDataCleanup(browser: BrowserStore) {
  const failed = new Set<string>();
  let generation = 0;
  let running = false;
  let stopListening: (() => void) | undefined;
  let delay: ReturnType<typeof setTimeout> | undefined;
  let releaseDelay: (() => void) | undefined;

  async function drain(run: number) {
    if (running) return;
    running = true;
    try {
      while (generation === run && stopListening) {
        const engine = browser.getState().orphanedProfileData.find((e) => !failed.has(e));
        if (engine === undefined) return;
        await new Promise<void>((resolve) => {
          releaseDelay = resolve;
          delay = setTimeout(resolve, CLOSE_DELAY_MS);
        });
        if (generation !== run || !stopListening) return;
        delay = undefined;
        releaseDelay = undefined;
        // A profile restored during the delay must retain its data.
        if (!browser.getState().orphanedProfileData.includes(engine)) continue;
        const remaining = await deleteProfileData(engine).catch((error: unknown) => [String(error)]);
        if (generation !== run || !stopListening) return;
        if (remaining.length) {
          failed.add(engine);
          console.warn(`Couldn't delete profile data (${engine || "original profile"}): ${remaining.join(", ")}`);
        } else {
          browser.getState().profileDataDeleted(engine);
        }
      }
    } finally {
      // A disposed run must not unlock another run started after it.
      if (generation === run) running = false;
    }
  }

  function dispose() {
    generation++;
    stopListening?.();
    stopListening = undefined;
    clearTimeout(delay);
    delay = undefined;
    releaseDelay?.();
    releaseDelay = undefined;
    running = false;
  }

  function start() {
    if (stopListening) {
      const run = generation;
      return () => { if (generation === run) dispose(); };
    }
    failed.clear();
    const run = generation;
    stopListening = browser.subscribe((s, prev) => {
      if (s.orphanedProfileData !== prev.orphanedProfileData) void drain(run);
    });
    void drain(run);
    return () => { if (generation === run) dispose(); };
  }

  return { start, dispose };
}

const profileDataCleanup = createProfileDataCleanup(useBrowser);
export const startProfileDataCleanup = profileDataCleanup.start;
