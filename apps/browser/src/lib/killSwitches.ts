import { checkSwitches, type ActiveSwitch, type SwitchCheck } from "@bay/chromium";
import { readDocument, writeDocument } from "@bay/desktop";
import * as v from "valibot";
import { create } from "zustand";

// Remote kill switches: a release can turn off a feature that broke without shipping an update. Bay publishes a small
// signed feed (apps/web/public/switches.json, signed by scripts/release/sign-switches.mjs); the app fetches it at
// launch and every few hours, and bay-switches (packages/rust/bay-switches) checks its signature and says which
// switches apply to this platform and release. The last feed accepted is kept, so a switch holds offline and from the
// first moment of the next launch, and a feed older than it is refused. Settings › Advanced says what's off and why.

export const SWITCHES_URL = "https://baybrowser.in/switches.json";
const KEPT_DOC = "switches.json";
const CHECK_EVERY_MS = 6 * 3_600_000;

/** What a switch can turn off: the feed's `feature`, and what Settings calls it. */
export const SWITCHABLE = {
  webkit: "WebKit pages",
  signInCarry: "Carrying sign-ins between engines",
  askPage: "Ask About This Page",
  sparePage: "Starting the next page early",
  plugins: "Plugins",
  sharedFolders: "Keeping folders in shared folders",
} as const;

export type SwitchFeature = keyof typeof SWITCHABLE;

export const useKillSwitches = create<{ active: readonly ActiveSwitch[]; checkedAt: number | null }>(() => ({ active: [], checkedAt: null }));

/** Whether Bay turned `feature` off for this release. */
export const switchedOff = (feature: SwitchFeature) => useKillSwitches.getState().active.some((s) => s.feature === feature);

/** The switches Settings lists: the ones this app knows, by its name for them, and any other with the feed's reason. */
export const switchTitle = (s: ActiveSwitch) => Object.entries(SWITCHABLE).find(([feature]) => feature === s.feature)?.[1] ?? s.feature;

const KeptSchema = v.object({ feed: v.string(), signature: v.string(), issued: v.number() });

type Kept = v.InferOutput<typeof KeptSchema>;

export type SwitchDeps = {
  fetch: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
  check: (feed: string, signature: string, lastIssued: number) => Promise<SwitchCheck | null>;
  read: () => string | null;
  write: (text: string) => void;
  now: () => number;
};

const defaults: SwitchDeps = {
  fetch: (url) => fetch(url, { cache: "no-store" }),
  check: checkSwitches,
  read: () => readDocument(KEPT_DOC),
  write: (text) => writeDocument(KEPT_DOC, text),
  now: Date.now,
};

function readKept(deps: SwitchDeps): Kept | null {
  try {
    const parsed = v.safeParse(KeptSchema, JSON.parse(deps.read() ?? "null"));

    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

async function fetchFeed(deps: SwitchDeps): Promise<{ feed: string; signature: string } | null> {
  try {
    const [feed, signature] = await Promise.all([deps.fetch(SWITCHES_URL), deps.fetch(`${SWITCHES_URL}.sig`)]);

    return feed.ok && signature.ok ? { feed: await feed.text(), signature: await signature.text() } : null;
  } catch {
    return null;
  }
}

export type SwitchRefresh = "updated" | "kept" | "unavailable";

/**
 * Applies the kept feed, then the published one if it checks out: "updated" when the published feed was taken, "kept"
 * when the kept one still stands (offline, refused, or the same feed), "unavailable" without the native check.
 */
export async function refreshKillSwitches(deps: SwitchDeps = defaults): Promise<SwitchRefresh> {
  const kept = readKept(deps);

  // The kept feed is checked again, not trusted from disk: its switches may have lapsed, and the file may be edited.
  if (kept) {
    const checked = await deps.check(kept.feed, kept.signature, 0).catch(() => null);

    if (!checked) return "unavailable";

    if (checked.ok) useKillSwitches.setState({ active: checked.switches, checkedAt: deps.now() });
  }

  const published = await fetchFeed(deps);

  if (!published || (kept && published.feed === kept.feed)) return kept ? "kept" : "unavailable";
  const checked = await deps.check(published.feed, published.signature, kept?.issued ?? 0).catch(() => null);

  if (!checked) return "unavailable";

  if (!checked.ok) return "kept";
  useKillSwitches.setState({ active: checked.switches, checkedAt: deps.now() });

  try {
    deps.write(JSON.stringify({ ...published, issued: checked.issued } satisfies Kept));
  } catch {}

  return "updated";
}

/** Checks at launch and every few hours, for the app's life. */
export function startKillSwitches(deps: SwitchDeps = defaults): () => void {
  const run = () => void refreshKillSwitches(deps).catch(() => {});
  run();
  const timer = setInterval(run, CHECK_EVERY_MS);

  return () => clearInterval(timer);
}
