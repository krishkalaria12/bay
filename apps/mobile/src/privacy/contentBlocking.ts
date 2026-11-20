import { create } from "zustand";

// The blocker itself is the Blocker service (blocker.ts), on the app's runtime. This is what it tells Settings.

export type BlockerStatus = { state: "off" } | { state: "loading" } | { state: "ready"; lists: number } | { state: "failed" };

/** What the engines are blocking with, for Settings. */
export const useBlockerStatus = create<{ status: BlockerStatus }>(() => ({ status: { state: "loading" } }));
