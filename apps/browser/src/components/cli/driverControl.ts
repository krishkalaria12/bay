// The terminal control: the command line tool that drives the app, and the app's side of it.
//
// The work is in components/cli/automationService.ts. This is where the app reaches it.
import type { CliControlStatus } from "@bay/chromium";
import * as Effect from "effect/Effect";
import { runDesktop } from "../../effect/runtime";
import { AutomationService, shownCliTab, useCli } from "./automationService";

export { shownCliTab, useCli };

/** Starts the terminal control: the server is asked for, and the active tab is kept. */
export function startCliControl() {
  void runDesktop(
    Effect.gen(function* () {
      const automation = yield* AutomationService;

      yield* automation.startCli;
    }),
  );
}

/** Installs the command line tool, and says how it went. */
export function installCliInBackground(): Promise<{ ok: boolean; appVersion: string; error?: string; binPath?: string; lines: string[] }> {
  return runDesktop(
    Effect.gen(function* () {
      const automation = yield* AutomationService;

      return yield* automation.install();
    }),
  );
}

/** What the app tells the user about the command line tool. */
export function describeCliInstall(state: ReturnType<typeof useCli.getState>): string {
  if (state.installing) return state.step ? `Installing (${state.step})…` : "Installing…";

  if (state.error) return state.error;

  if (state.installedVersion) return state.binPath ? `Installed at ${state.binPath}` : `Version ${state.installedVersion} is installed.`;

  return "Run Bay from your terminal with TypeScript or JavaScript.";
}

/** What the app tells the user about the terminal control. */
export function describeCliControl(server: CliControlStatus | null): string {
  if (server?.reason) return server.reason;

  if (server?.state === "starting") return "Starting terminal control…";

  if (server?.state === "external") return "This development instance uses an explicit debugging port.";

  if (server?.state === "on" && server.connections) return `${server.connections} ${server.connections === 1 ? "command is" : "commands are"} connected.`;

  return "Commands can read and interact with open Chromium pages and install userscripts. Turning this off disconnects them.";
}
