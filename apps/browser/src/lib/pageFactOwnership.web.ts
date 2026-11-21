import { getNativeHostInfo } from "@bay/platform/nativeBridge";

/** Shared-runtime page facts arrive through the coordinator's native subscription. */
export function pageFactsInCoordinator(): boolean {
  return getNativeHostInfo().constants.BayShell?.sharedRuntime === true;
}
