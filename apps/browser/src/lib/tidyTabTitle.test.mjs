import assert from "node:assert/strict";
import { test } from "node:test";
const { tidyTabTitle } = await import("./tidyTabTitle.ts");

test("shortens Inbox – Gmail to Gmail", () => {
  assert.equal(tidyTabTitle("Inbox – Gmail", "https://mail.google.com"), "Gmail");
});

test("shortens Rick Astley - YouTube to YouTube", () => {
  assert.equal(tidyTabTitle("Rick Astley - YouTube", "https://www.youtube.com/watch?v=x"), "YouTube");
});

test("shortens GitHub - facebook/react to GitHub", () => {
  assert.equal(tidyTabTitle("GitHub - facebook/react", "https://github.com/facebook/react"), "GitHub");
});

test("returns null when no separator", () => {
  assert.equal(tidyTabTitle("Google", "https://google.com"), null);
});

test("returns null when already the brand", () => {
  assert.equal(tidyTabTitle("Gmail", "https://mail.google.com"), null);
});

test("fallback picks shorter side", () => {
  assert.equal(tidyTabTitle("Dashboard – Acme", "https://example.com"), "Acme");
});

test("handles null/empty", () => {
  assert.equal(tidyTabTitle("", "https://example.com"), null);
  assert.equal(tidyTabTitle("https://example.com", "https://example.com"), null);
});
