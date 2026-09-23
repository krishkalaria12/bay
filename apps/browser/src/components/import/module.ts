import type * as ImportApi from "@bay/import";

let api: typeof ImportApi | null | undefined;

/**
 * @bay/import, loaded on first use: its native module only exists in app
 * builds made after it was linked, and requiring it throws in older ones (Metro
 * serves the same JS to every build). Null when it isn't available.
 */
export function importModule(): typeof ImportApi | null {
  if (api === undefined) {
    try {
      api = require("@bay/import") as typeof ImportApi;
    } catch {
      api = null;
    }
  }
  return api;
}
