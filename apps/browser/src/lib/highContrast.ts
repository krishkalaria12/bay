import * as v from "valibot";
import { create } from "zustand";

// The desktop's high-contrast setting (prefers-contrast: more), kept current. Web hosts only: React Native on macOS has
// no matchMedia, so its windows keep the standard theme.
const query = v.is(v.function_(), globalThis.matchMedia) ? globalThis.matchMedia("(prefers-contrast: more)") : null;

export const useHighContrast = create<boolean>(() => query?.matches ?? false);

query?.addEventListener("change", (event) => useHighContrast.setState(event.matches, true));
