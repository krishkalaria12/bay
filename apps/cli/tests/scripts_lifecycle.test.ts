import { describe, expect, it, spyOn } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Report, Run } from "../src/scriptsTest.ts";
import { parseMeta } from "../src/userscript.ts";

const script = { meta: parseMeta("", "fixture.js"), source: "", path: "fixture.js", js: "", sourcemap: null, warnings: [] };

describe("script test lifecycle waits", () => {
  it.each([
    ["waitTopSettled", "topSettledWaiters", "notifyTopSettled"],
    ["waitLoaded", "loadedWaiters", "notifyLoaded"],
  ] as const)("clears the timer and waiter when %s is interrupted", async (wait, waiters, notify) => {
    const run = new Run(script, "https://example.com", new Report(script.path, "https://example.com", script.meta.run_at));
    const controller = new AbortController();
    const timers = spyOn(globalThis, "setTimeout");
    const cleared = spyOn(globalThis, "clearTimeout");

    const waiting = Effect.runPromiseExit(
      Effect.promise((signal) => run[wait](30_000, signal)),
      { signal: controller.signal },
    );

    try {
      expect(run[waiters]).toHaveLength(1);
      const timer = timers.mock.results[0]?.value;

      controller.abort();

      expect(Exit.isFailure(await waiting)).toBe(true);
      expect(run[waiters]).toHaveLength(0);
      expect(cleared).toHaveBeenCalledWith(timer);
    } finally {
      run[notify]();
      timers.mockRestore();
      cleared.mockRestore();
    }
  });

  it.each([
    ["waitTopSettled", "topSettledWaiters", "notifyTopSettled"],
    ["waitLoaded", "loadedWaiters", "notifyLoaded"],
  ] as const)("notifies every concurrent %s waiter", async (wait, waiters, notify) => {
    const run = new Run(script, "https://example.com", new Report(script.path, "https://example.com", script.meta.run_at));
    const waiting = [run[wait](1000), run[wait](1000)];

    run[notify]();

    expect(await Promise.all(waiting)).toEqual([true, true]);
    expect(run[waiters]).toHaveLength(0);
  });
});
