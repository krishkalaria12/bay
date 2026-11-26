import { describe, expect, test } from "bun:test";
import type { CdpListener, CdpObject } from "../src/cdp.ts";
import { HookTracker, hookFilter, hookInput, watchHooks, type HookSession } from "../src/hooks.ts";
import { program, statusOf } from "../src/cli.ts";
import { Effect } from "effect";

const info = (targetId: string, url: string, title = "", type = "page") => ({ targetInfo: { targetId, type, url, title } });

describe("HookTracker", () => {
  test("opened, navigated, loaded and closed tabs fire once each", () => {
    const tracker = new HookTracker();
    tracker.seed([{ targetId: "old", type: "page", url: "https://old.example/", title: "Old" }]);

    expect(tracker.feed("Target.targetCreated", info("A", "https://a.example/", "A"))).toEqual([
      { event: "tab-opened", tabId: "A", url: "https://a.example/", title: "A" },
    ]);
    // A title change alone fires nothing.
    expect(tracker.feed("Target.targetInfoChanged", info("A", "https://a.example/", "A!"))).toEqual([]);
    expect(tracker.feed("Target.targetInfoChanged", info("A", "https://a.example/next", "Next"))[0]?.event).toBe("tab-navigated");
    tracker.attached("s1", "A");
    expect(tracker.feed("Page.loadEventFired", {}, "s1")).toEqual([{ event: "page-loaded", tabId: "A", url: "https://a.example/next", title: "Next" }]);
    expect(tracker.feed("Target.targetDestroyed", { targetId: "A" })[0]?.event).toBe("tab-closed");
    expect(tracker.feed("Target.targetDestroyed", { targetId: "A" })).toEqual([]);
    expect(tracker.feed("Target.targetDestroyed", { targetId: "old" })[0]?.url).toBe("https://old.example/");
  });

  test("Bay's own views and other targets are out of sight", () => {
    const tracker = new HookTracker();

    expect(tracker.feed("Target.targetCreated", info("W", "https://w.example/", "", "service_worker"))).toEqual([]);
    expect(tracker.feed("Target.targetCreated", info("N", "bay://newtab"))).toEqual([]);
    // The new tab page goes to the web: it opens as far as hooks know.
    expect(tracker.feed("Target.targetInfoChanged", info("N", "https://n.example/"))[0]?.event).toBe("tab-opened");
    expect(tracker.feed("Page.loadEventFired", {}, "unknown")).toEqual([]);
  });
});

test("--match takes a Chrome match pattern", () => {
  const only = hookFilter("https://*.example.com/*");

  expect(only("https://docs.example.com/a")).toBe(true);
  expect(only("https://example.org/")).toBe(false);
  expect(hookFilter(null)("about:blank")).toBe(true);
  expect(() => hookFilter("example.com")).toThrow();
});

test("a hook hears the event in its environment and on stdin", () => {
  const input = hookInput({ event: "tab-opened", tabId: "A", url: "https://a.example/", title: "A" });

  expect(input.env).toEqual({ BAY_EVENT: "tab-opened", BAY_TAB_ID: "A", BAY_URL: "https://a.example/", BAY_TITLE: "A" });
  expect(JSON.parse(input.stdin)).toEqual({ event: "tab-opened", tabId: "A", url: "https://a.example/", title: "A" });
});

function fakeSession() {
  const listeners = new Set<CdpListener>();
  const sent: { method: string; session?: string }[] = [];
  let close = () => {};
  const closed = new Promise<void>((resolve) => (close = resolve));

  const session: HookSession = {
    getTargets: async () => [{ targetId: "old", type: "page", url: "https://old.example/", title: "Old" }],
    cdp: {
      send: async (method: string, _params: CdpObject = {}, sessionId?: string): Promise<CdpObject> => {
        sent.push({ method, session: sessionId });

        return method === "Target.attachToTarget" ? { sessionId: `s-${sent.length}` } : {};
      },
      addListener: (listener: CdpListener) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
      whenClosed: () => closed,
    },
  };

  const emit = (method: string, params: CdpObject, sessionId?: string) => {
    for (const listener of listeners) listener(method, params, sessionId);
  };

  return { session, sent, emit, close };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("watchHooks runs the program for matching events until the connection ends", async () => {
  const fake = fakeSession();
  const runs: string[] = [];

  const watching = watchHooks(fake.session, {
    event: "tab-opened",
    match: hookFilter("https://*.example/*"),
    command: ["hook"],
    once: false,
    parallel: 2,
    spawn: async (_command, input) => (runs.push(input.env.BAY_URL!), 0),
  });

  await tick();
  fake.emit("Target.targetCreated", info("A", "https://a.example/"));
  fake.emit("Target.targetCreated", info("B", "https://b.other/"));
  await tick();
  fake.close();

  expect(await watching).toBeNull();
  expect(runs).toEqual(["https://a.example/"]);
  expect(fake.sent.map((s) => s.method)).toEqual(["Target.setDiscoverTargets"]);
});

test("page-loaded attaches to every tab, and --once ends with the program's status", async () => {
  const fake = fakeSession();

  const watching = watchHooks(fake.session, {
    event: "page-loaded",
    match: () => true,
    command: ["hook"],
    once: true,
    parallel: 4,
    spawn: async () => 3,
  });

  await tick();
  const attach = fake.sent.find((s) => s.method === "Page.enable");

  expect(attach?.session).toBeDefined();
  fake.emit("Page.loadEventFired", {}, attach!.session);

  expect(await watching).toBe(3);
});

test("bay on needs a command after the event", async () => {
  expect(statusOf(await Effect.runPromiseExit(program(["on", "tab-opened"])))).toBe(1);
  expect(statusOf(await Effect.runPromiseExit(program(["on", "page-done", "--", "true"])))).toBe(1);
});
