// Engines report navigation state dozens of times per load (progress, title, history), for hidden tabs too. These
// decide which reports run page scripts (only a new document needs them) and which are worth a render.

export interface ScriptTiming {
  /** The last event was loading. Starts true so the first settled event counts as a finished load. */
  loading: boolean;
  /** The address the media watcher was installed for during this load, and the progress last seen. */
  watchedUrl: string | null;
  progress: number;
  /** The last hide-elements run applied rules, so the page has some to clear. */
  hidden: boolean;
}

export const initialTiming = (): ScriptTiming => ({ loading: true, watchedUrl: null, progress: 0, hidden: false });

/** Updates `timing` for one navigation event and returns the scripts to run on the page. */
export function scriptsFor(timing: ScriptTiming, state: { url: string; progress: number; isLoading: boolean }, hasRules: boolean): MediaWatchPlan {
  let watchMedia = false;
  let hideElements = false;

  if (state.isLoading) {
    // A new load, or progress starting over, is a new document; so is an address change once it commits.
    if (!timing.loading || state.progress < timing.progress) timing.watchedUrl = null;

    // Media can play before a page finishes loading (a media file streams for as long as it plays).
    if (state.progress > 0.1 && state.url !== timing.watchedUrl) {
      timing.watchedUrl = state.url;
      watchMedia = true;
    }

    timing.progress = state.progress;
  } else if (timing.loading) {
    watchMedia = true;
    hideElements = shouldHide(timing, hasRules);
  }

  timing.loading = state.isLoading;

  return { watchMedia, hideElements };
}

interface MediaWatchPlan {
  watchMedia: boolean;
  hideElements: boolean;
}

/** Whether to run hide-elements now; skipped when there's nothing to apply or clear. */
export function shouldHide(timing: ScriptTiming, hasRules: boolean): boolean {
  const run = hasRules || timing.hidden;

  if (run) timing.hidden = hasRules;

  return run;
}

interface Navigation {
  url: string;
  title: string;
  progress: number;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Whether a report changes nothing the screen shows. Only the active tab's progress is drawn. */
export function sameNavigation(before: Navigation, after: Navigation, ignoreProgress: boolean): boolean {
  return (
    before.url === after.url &&
    before.title === after.title &&
    before.isLoading === after.isLoading &&
    before.canGoBack === after.canGoBack &&
    before.canGoForward === after.canGoForward &&
    (ignoreProgress || before.progress === after.progress)
  );
}
