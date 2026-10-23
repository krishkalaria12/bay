// High contrast (prefers-contrast: more) on web hosts: detection.
import assert from "node:assert/strict";
import { test } from "node:test";

const changes = [];
globalThis.matchMedia = (query) => ({ matches: query === "(prefers-contrast: more)", addEventListener: (_type, listener) => changes.push(listener) });
const { useHighContrast } = await import("./highContrast.ts");

test("the desktop's setting is read, and followed when it changes", () => {
  assert.equal(useHighContrast.getState(), true);
  for (const listener of changes) listener({ matches: false });
  assert.equal(useHighContrast.getState(), false);
  for (const listener of changes) listener({ matches: true });
  assert.equal(useHighContrast.getState(), true);
});
