import { create } from "zustand";
import type { OnboardingStep } from "../components/onboarding/state";

// Where onboarding runs when documents are separate. The coordinator knows at launch whether this is a first run, and
// the window document draws the overlay, so the one tells the other through the shared service state.
export type OnboardingRequest = {
  windowId: string | null;
  step: OnboardingStep;
  picked: Partial<Record<OnboardingStep, string[]>>;
  session: number;
};

export const useOnboardingRequest = create<OnboardingRequest>(() => ({ windowId: null, step: "intro", picked: {}, session: 0 }));

export function requestOnboarding(windowId: string, step: OnboardingStep, picked: OnboardingRequest["picked"]) {
  useOnboardingRequest.setState((request) => ({ windowId, step, picked, session: request.session + 1 }));
}

/** Runs `start` for each new request naming this window, whether it came before this document started or after. */
export function followOnboardingRequests(windowId: string, start: (request: OnboardingRequest) => void): () => void {
  let seen = 0;
  const follow = (request: OnboardingRequest) => {
    if (request.windowId !== windowId || request.session === seen) return;
    seen = request.session;
    start(request);
  };
  follow(useOnboardingRequest.getState());
  return useOnboardingRequest.subscribe(follow);
}
