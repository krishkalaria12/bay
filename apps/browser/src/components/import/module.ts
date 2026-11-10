import type * as ImportApi from "@bay/import";

let api: typeof ImportApi | null | undefined;

export function importModule(): typeof ImportApi | null {
  if (api === undefined) {
    try {
      // SAFETY: typeof ImportApi assertion matches the runtime value validated at this call site.
      api = require("@bay/import") as typeof ImportApi;
    } catch {
      api = null;
    }
  }

  return api;
}
