// Where the settings panes reach their workflows (workflows.ts), on the runtime the app shares.
import * as Effect from "effect/Effect";
import { runWindow } from "../../effect/windowRuntime";
import { SettingsWorkflows, type Workflows } from "./workflows";

export { usePasswordsUnlocked } from "./workflows";

/** Runs something with the settings' workflows. */
export const withWorkflows = <A>(program: (workflows: Workflows) => Effect.Effect<A>): Promise<A> =>
  runWindow(
    Effect.gen(function* () {
      const workflows = yield* SettingsWorkflows;

      return yield* program(workflows);
    }),
  );
