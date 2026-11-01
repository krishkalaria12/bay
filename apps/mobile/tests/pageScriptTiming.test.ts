import assert from "node:assert/strict";
import test from "node:test";

import { initialTiming, scriptsFor, shouldHide } from "../src/browser/pageScriptTiming.ts";

const A = "https://a.example/";
const B = "https://b.example/";
const ev = (url: string, progress: number, isLoading: boolean) => ({ url, progress, isLoading });

// Feeds events and returns which scripts each one ran: "m" media watcher, "h" hide elements.
function run(events: ReturnType<typeof ev>[], hasRules = false, timing = initialTiming()): string[] {
  return events.map((event) => {
    const { watchMedia, hideElements } = scriptsFor(timing, event, hasRules);
    return (watchMedia ? "m" : "") + (hideElements ? "h" : "");
  });
}

test("a load runs the media watcher once mid-load and once when it finishes", () => {
  const events = [ev(A, 0, true), ev(A, 0.05, true), ev(A, 0.3, true), ev(A, 0.6, true), ev(A, 0.9, true), ev(A, 1, false), ev(A, 1, false)];
  assert.deepEqual(run(events), ["", "", "m", "", "", "m", ""]);
});

test("hide rules run only when a load finishes, and never with nothing to apply or clear", () => {
  assert.deepEqual(run([ev(A, 0.5, true), ev(A, 1, false), ev(A, 1, false)], true), ["m", "mh", ""]);
  assert.deepEqual(run([ev(A, 0.5, true), ev(A, 1, false)], false), ["m", "m"]);
});

test("the first settled event counts as a finished load", () => {
  assert.deepEqual(run([ev(A, 1, false), ev(A, 1, false)], true), ["mh", ""]);
});

test("the watcher reinstalls when the new document commits or progress starts over", () => {
  // Android reports the old page's progress until the new one commits, then the new address.
  const navigation = [ev(A, 1, false), ev(B, 0, true), ev(A, 1, true), ev(B, 0.1, true), ev(B, 0.4, true), ev(B, 0.5, true), ev(B, 1, false)];
  assert.deepEqual(run(navigation), ["m", "", "m", "", "m", "", "m"]);
  // A reload keeps the address; its progress starting over marks the new document.
  const reload = [ev(A, 1, false), ev(A, 1, true), ev(A, 0.1, true), ev(A, 0.3, true), ev(A, 1, false)];
  assert.deepEqual(run(reload), ["m", "m", "", "m", "m"]);
});

test("a history change without a load runs nothing", () => {
  assert.deepEqual(run([ev(A, 1, false), ev(`${A}#next`, 1, false)], true), ["mh", ""]);
});

test("removing every rule clears them once", () => {
  const timing = initialTiming();
  assert.equal(shouldHide(timing, false), false);
  assert.equal(shouldHide(timing, true), true);
  assert.equal(shouldHide(timing, false), true);
  assert.equal(shouldHide(timing, false), false);
  // A finished load after rules went away clears what an earlier document may still show.
  shouldHide(timing, true);
  assert.deepEqual(run([ev(B, 0.5, true), ev(B, 1, false), ev(B, 0.5, true), ev(B, 1, false)], false, timing), ["m", "mh", "m", "m"]);
});
