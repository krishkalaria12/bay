import { create } from "zustand";

// The blocker itself is the Blocker service (blocker.ts), on the app's runtime. This is what it tells Settings.

export type BlockerStatus = { state: "off" } | { state: "loading" } | { state: "ready"; lists: number } | { state: "failed" };

/** What the engines are blocking with, for Settings. */
export const useBlockerStatus = create<{ status: BlockerStatus }>(() => ({ status: { state: "loading" } }));

/**
 * Sites shown without blocking for this visit only (C2, "Page broken? Reload it without blocking"): nothing saves
 * them, and the screen drops a site once its tab leaves it. The blocker pauses them with the saved ones.
 */
export const useRestoredSites = create<{ hosts: readonly string[] }>(() => ({ hosts: [] }));
