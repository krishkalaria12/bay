import { create } from "zustand";
import { defaultBrowserCheckInDoneAt, defaultBrowserTrialStartedAt, recordDefaultBrowserCheckInDone } from "../components/onboarding/state";
import { useBrowser } from "../store/browser";
import { sendFeedback } from "./appIntegration";
import { CHECK_IN_AFTER_MS } from "./constants";

type CheckIn = { trialStartedAt: number | null; doneAt: number | null };

const useCheckIn = create<CheckIn>(() => ({ trialStartedAt: defaultBrowserTrialStartedAt(), doneAt: defaultBrowserCheckInDoneAt() }));

export function checkInDue({ trialStartedAt, doneAt }: CheckIn, now = Date.now()): boolean {
  return trialStartedAt !== null && doneAt === null && now - trialStartedAt >= CHECK_IN_AFTER_MS;
}

export function dismissDefaultBrowserCheckIn() {
  recordDefaultBrowserCheckInDone();
  useCheckIn.setState({ doneAt: Date.now() });
}

// Never show the check-in in incognito.
export function useDefaultBrowserCheckIn(windowId: string) {
  const due = useCheckIn(checkInDue);
  const incognito = useBrowser((s) => !!s.windows[windowId]?.incognito);
  return {
    visible: due && !incognito,
    leaveFeedback() {
      dismissDefaultBrowserCheckIn();
      void sendFeedback(windowId);
    },
    dismiss: dismissDefaultBrowserCheckIn,
  };
}

if (__DEV__) (globalThis as { nnCheckIn?: unknown }).nnCheckIn = { store: useCheckIn, due: () => checkInDue(useCheckIn.getState()) };
