import { capabilities } from "@bay/platform";
import { launchEnvironment, readDocument, stopIntroMusic, writeDocument } from "@bay/shell";
import { create } from "zustand";
import { useBrowserRead as useBrowser } from "../../store/read";
import { resolveWindowId } from "../../store/model";
import { pinSites } from "./sites";
import { endToolTour, startToolTour } from "./tour/state";
import { ONBOARDING_DOC } from "./constants";

export type OnboardingStep = "intro" | "import" | "personalize" | "search" | "pinnedTabs" | "privacy" | "defaultBrowser" | "outro";

export const STEPS: OnboardingStep[] = ["intro", "import", "personalize", "search", "pinnedTabs", "privacy", "defaultBrowser", "outro"];

export const FIRST_STEP: OnboardingStep = "import";

type OnboardingState = {
  windowId: string | null;
  step: OnboardingStep;
  leaving: boolean;
  session: number;
  tourAfter: boolean;
  // What each step set up, as lines for the outro's postcard. A skipped step has none.
  picked: Partial<Record<OnboardingStep, string[]>>;
};

export const useOnboarding = create<OnboardingState>(() => ({
  windowId: null,
  step: capabilities.introMusic ? "intro" : FIRST_STEP,
  leaving: false,
  session: 0,
  tourAfter: false,
  picked: {},
}));

const stepAfter = (step: OnboardingStep, delta: number) => STEPS[STEPS.indexOf(step) + delta];

// The step is saved as it shows, so a relaunch picks up where you were.
export function goToStep(step: OnboardingStep) {
  useOnboarding.setState({ step });
  if (step !== "intro") save({ step });
}

function advance(step: OnboardingStep, picked: string[] | undefined) {
  const all = { ...useOnboarding.getState().picked };
  if (picked?.length) all[step] = picked;
  else delete all[step];
  useOnboarding.setState({ picked: all });
  save({ picked: all });
  const after = stepAfter(step, 1);
  if (after) goToStep(after);
  else finishOnboarding();
}

// Continue: the step has applied its choices; `picked` describes them.
export const nextStep = (picked?: string[]) => advance(useOnboarding.getState().step, picked);

// Skip: the step applies nothing, and the postcard forgets anything it set before.
export const skipStep = () => advance(useOnboarding.getState().step, undefined);

export function previousStep() {
  const before = stepAfter(useOnboarding.getState().step, -1);
  if (before && before !== "intro") goToStep(before);
}

export const isFirstStep = (step: OnboardingStep) => step === FIRST_STEP;

type Saved = {
  version: 1;
  startedAt?: number;
  completedAt: number | null;
  step?: OnboardingStep;
  picked?: Partial<Record<OnboardingStep, string[]>>;
  defaultBrowserTrialStartedAt?: number;
  defaultBrowserCheckInDoneAt?: number;
  introMusicMuted?: boolean;
};

function readSaved(): Saved | null {
  try {
    const json = readDocument(ONBOARDING_DOC);
    return json ? (JSON.parse(json) as Saved) : null;
  } catch {
    return null;
  }
}

function save(patch: Partial<Saved>) {
  try {
    writeDocument(ONBOARDING_DOC, JSON.stringify({ version: 1, completedAt: null, ...readSaved(), ...patch } satisfies Saved));
  } catch (error) {
    console.warn("Couldn't save onboarding state", error);
  }
}

const markCompleted = () => save({ completedAt: Date.now() });

export const recordDefaultBrowserTrial = () => save({ defaultBrowserTrialStartedAt: Date.now() });

export const defaultBrowserTrialStartedAt = () => readSaved()?.defaultBrowserTrialStartedAt ?? null;

export const defaultBrowserCheckInDoneAt = () => readSaved()?.defaultBrowserCheckInDoneAt ?? null;
export const recordDefaultBrowserCheckInDone = () => save({ defaultBrowserCheckInDoneAt: Date.now() });

export const onboardingCompletedAt = () => readSaved()?.completedAt ?? null;

export const introMusicMuted = () => readSaved()?.introMusicMuted ?? false;
export const saveIntroMusicMuted = (muted: boolean) => save({ introMusicMuted: muted });

export function startOnboarding(windowId?: string | null, step: OnboardingStep = "intro", picked: OnboardingState["picked"] = {}) {
  const id = resolveWindowId(useBrowser.getState(), windowId);
  if (!id) return;
  endToolTour();
  // Builds without the intro's music (Windows, Linux) start at the first setup step.
  const first = step === "intro" && !capabilities.introMusic ? FIRST_STEP : step;
  useOnboarding.setState((s) => ({ windowId: id, step: first, picked, leaving: false, tourAfter: false, session: s.session + 1 }));
  if (first !== "intro") save({ step: first });
}

export function finishOnboarding(options: { tour?: boolean } = {}) {
  markCompleted();
  stopIntroMusic(0.6);
  const { windowId } = useOnboarding.getState();
  if (windowId) useOnboarding.setState({ leaving: true, tourAfter: !!options.tour });
}

export function dismissOnboarding(session: number) {
  const { session: current, windowId, tourAfter } = useOnboarding.getState();
  if (current !== session) return;
  useOnboarding.setState({ windowId: null, step: capabilities.introMusic ? "intro" : FIRST_STEP, leaving: false, tourAfter: false, picked: {} });
  if (tourAfter && windowId) startToolTour(windowId);
}

export function maybeStartOnboarding() {
  const saved = readSaved();
  if (saved?.completedAt) return;
  if (saved?.startedAt) {
    const step = saved.step && STEPS.includes(saved.step) && saved.step !== "intro" ? saved.step : FIRST_STEP;
    return startOnboarding(null, step, saved.picked ?? {});
  }
  if (readDocument("session.json")) return markCompleted();
  if (__DEV__ && launchEnvironment("BAY_ONBOARDING") !== "1") return;
  save({ startedAt: Date.now() });
  startOnboarding();
}

if (__DEV__)
  (globalThis as { nnOnboarding?: unknown }).nnOnboarding = {
    store: useOnboarding,
    go: goToStep,
    start: startOnboarding,
    finish: finishOnboarding,
    pinSites,
  };
