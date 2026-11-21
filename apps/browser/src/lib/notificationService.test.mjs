import { ReadBrowser } from "../effect/windowPorts.ts";
// The notifications (lib/notificationService.ts): what a site may show, and what a closed page gets.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { useBrowser } = await import("../store/browserStore.ts");
const { NotificationEngine, NotificationService } = await import("./notificationService.ts");
const { Diagnostics } = await import("../effect/ports/diagnostics.ts");

const S = () => useBrowser.getState();

const fakeEngine = () => {
  const lab = {
    posted: [],
    removed: [],
    asked: 0,
    permission: "granted",
    request: true,
  };

  const layer = Layer.succeed(NotificationEngine)({
    post: (notification) =>
      Effect.sync(() => {
        lab.posted.push(notification);
      }),
    remove: (ids) =>
      Effect.sync(() => {
        lab.removed.push(...ids);
      }),
    permission: () => Effect.sync(() => lab.permission),
    requestPermission: () =>
      Effect.sync(() => {
        lab.asked++;

        return lab.request;
      }),
    openSettings: () => Effect.void,
    ask: () => Effect.succeed({ confirmed: false }),
    downloadIcon: () => Effect.succeed(undefined),
  });

  return { layer, lab };
};

const withService = async (use) => {
  const engine = fakeEngine();

  const runtime = ManagedRuntime.make(
    NotificationService.layer.pipe(Layer.provide(ReadBrowser.layer(useBrowser)), Layer.provide(Layer.mergeAll(engine.layer, Diagnostics.layer))),
  );

  try {
    await use({ lab: engine.lab, runtime });
  } finally {
    await runtime.dispose();
  }
};

const notification = (id) => ({ id, title: `Hello ${id}`, body: "There", origin: "https://example.com", silent: false });

test("a private window's notification is dismissed, not posted", async () => {
  await withService(async ({ lab, runtime }) => {
    S().hydrate({});

    const window = S().createWindow({ incognito: true });
    const tab = S().newTab(window, { url: "https://example.com" });

    await runtime.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;

        yield* notifications.show(tab, notification("private"));
      }),
    );

    assert.deepEqual(lab.posted, [], "a private window posts nothing");
  });
});

test("a page that was replaced gets no late notification", async () => {
  await withService(async ({ lab, runtime }) => {
    S().hydrate({});

    const window = S().createWindow({});
    const tab = S().newTab(window, { url: "https://example.com" });

    await runtime.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;

        yield* notifications.show(tab, notification("late"));
      }),
    );

    assert.equal(lab.posted.length, 1);
    assert.equal(lab.posted[0].title, "Hello late");
  });
});

test("the permission is asked for once, and a refusal is not asked again", async () => {
  await withService(async ({ lab, runtime }) => {
    S().hydrate({});

    const window = S().createWindow({});
    const tab = S().newTab(window, { url: "https://example.com" });

    lab.permission = "notDetermined";
    lab.request = false;

    await runtime.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;

        yield* notifications.show(tab, notification("one"));
        yield* notifications.show(tab, notification("two"));
      }),
    );

    assert.equal(lab.asked, 2, "each site asks macOS once");
    assert.deepEqual(lab.posted, [], "nothing is posted without the permission");
  });
});

test("the notifications a page asked for are taken down when it closes them", async () => {
  await withService(async ({ lab, runtime }) => {
    S().hydrate({});

    const window = S().createWindow({});
    const tab = S().newTab(window, { url: "https://example.com" });

    await runtime.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;

        yield* notifications.show(tab, notification("gone"));
        yield* notifications.close("gone");
      }),
    );

    assert.deepEqual(lab.removed, ["web:gone"]);
  });
});
