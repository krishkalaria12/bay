import { requireNativeModule, requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";

/** Whether Bay is the phone's default browser. `unknown` when the system won't say; `unavailable` when it can't be. */
export type DefaultBrowser = "default" | "not" | "unknown" | "unavailable";

/** What asking did: Bay is the default now, the person said no, or the setting opened for them to choose there. */
export type MakeDefault = "default" | "not" | "settings" | "unavailable";

interface BayWelcomeModule {
  defaultBrowser(): DefaultBrowser;
  makeDefaultBrowser(): Promise<MakeDefault>;
}

const native = requireNativeModule<BayWelcomeModule>("BayWelcome");

/** Whether Bay is the phone's default browser, as far as the system says. */
export function defaultBrowser(): DefaultBrowser {
  return native.defaultBrowser();
}

/** Asks to be the default browser: Android's own dialog in place, iOS's Default Apps settings. */
export function makeDefaultBrowser(): Promise<MakeDefault> {
  return native.makeDefaultBrowser();
}

/** The welcome's name in Liquid Glass (iOS only), fitted to the view's frame. */
export const GlassNameView: ComponentType<ViewProps & { text: string }> = requireNativeView("BayWelcome");
