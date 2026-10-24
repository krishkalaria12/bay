import { isWindows } from "@bay/platform";
import { getNativeHostInfo } from "@bay/platform/nativeBridge";

/** Shared-runtime page facts arrive through the coordinator's native subscription. */
export function pageFactsInCoordinator(): boolean {
  return isWindows && getNativeHostInfo().constants.BayShell?.sharedRuntime === true;
}
