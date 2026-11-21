// Settings mutations run against the authority after the command broker validates the source and space.
import * as Effect from "effect/Effect";
import { runForStore } from "../../effect/runtime";
import type { JsonValue } from "../../lib/json";
import { engineProfileFor } from "../../store/model";
import type { BrowserStore } from "../../store/browserStore";
import { SettingsWorkflows, type ClearRequest } from "./workflows";

export type SettingsAction = "settingsUnlock" | "settingsPasswords" | "settingsImportCsv" | "settingsExportCsv" | "settingsClearData";

export async function executeSettingsAction(store: BrowserStore, action: SettingsAction, args: [string, ClearRequest?]): Promise<JsonValue> {
  const [spaceId, request] = args;
  const profile = engineProfileFor(spaceId, store.getState().spaces);

  const result = await runForStore(
    store,
    Effect.gen(function* () {
      const workflows = yield* SettingsWorkflows;

      switch (action) {
        case "settingsUnlock":
          return yield* workflows.unlock(profile);
        case "settingsPasswords":
          return yield* workflows.passwords(profile);
        case "settingsImportCsv":
          return yield* workflows.importCsv(profile);
        case "settingsExportCsv":
          return yield* workflows.exportCsv(profile);
        case "settingsClearData":
          if (!request) throw new Error("The clear-data request is missing");

          return yield* workflows.clearData(spaceId, request);
      }
    }),
  );

  // Native metadata can include absent optional fields; JSON is the command protocol's representation.
  return JSON.parse(JSON.stringify(result));
}
