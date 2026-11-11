// Metro's dev split-bundle URLs cannot resolve this module outside the app root.
// Keep it in the main bundle, but defer evaluating the catalog until it is needed.
export const loadBundledBangs = (): Promise<typeof import("@bay/core/src/bangList.ts")> => Promise.resolve().then(() => require("@bay/core/src/bangList.ts"));
