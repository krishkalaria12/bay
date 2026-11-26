import { engineCall } from "./engineInfo";

// The spare page (engine nn_spare.h): a renderer started ahead of the page the person is about to open. Chrome warms
// it when its omnibox takes focus; Bay's address bar is the app's own, so the app asks.

export type SpareWarmup = { warmed: boolean; reason?: "batterySaver" | "failed" };

export const warmSpareRenderer = (profile: string) => engineCall<SpareWarmup>("nn_spare_warmup", profile);
