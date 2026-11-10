// The app's own scripts (Bay Scripts): the folder the user keeps them in, and the engine profiles they are loaded
// into.
//
// The work is in components/cli/automationService.ts. This is where the app reaches it.
import { userScriptsAvailable } from "@bay/desktop";
import * as Effect from "effect/Effect";
import { runDesktop } from "../../effect/runtime";
import { AutomationService, scriptsTargets } from "./automationService";

export { scriptsTargets };

let started = false;

/** Watches the folder, and applies the scripts to the profiles that want them. */
export function startUserScripts() {
  if (started || !userScriptsAvailable()) return;

  started = true;

  void runDesktop(
    Effect.gen(function* () {
      const automation = yield* AutomationService;

      yield* automation.start;
    }),
  );
}

if (__DEV__)
  // SAFETY: bayUserScripts is a dev-only debug handle on globalThis with no ambient declaration; production never reads this name.
  (globalThis as { bayUserScripts?: unknown }).bayUserScripts = { scriptsTargets };
