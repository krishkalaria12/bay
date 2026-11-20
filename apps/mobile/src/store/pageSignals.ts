import { create } from "zustand";

/**
 * What pages report many times while they load: how far each tab has got, and how many ads and trackers each has
 * blocked. It is kept out of the browser screen's state, so a busy page renders the capsule's progress line and the
 * page menu's count, not the whole screen.
 */
interface PageSignals {
  readonly progress: Readonly<Record<string, number>>;
  readonly blocked: Readonly<Record<string, number>>;
}

export const usePageSignals = create<PageSignals>(() => ({ progress: {}, blocked: {} }));

/** How far a tab's page has loaded, from 0 to 1. */
export function reportProgress(tabId: string, value: number): void {
  usePageSignals.setState((state) => (state.progress[tabId] === value ? state : { progress: { ...state.progress, [tabId]: value } }));
}

/** How many requests a tab's page has had blocked. */
export function reportBlocked(tabId: string, count: number): void {
  usePageSignals.setState((state) => (state.blocked[tabId] === count ? state : { blocked: { ...state.blocked, [tabId]: count } }));
}
