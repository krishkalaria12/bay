import { AuthorityStore } from "../effect/ports/store.ts";
// The local files (lib/localFileService.ts): what this Mac may read of a Space's files, and what it opens.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { useBrowser } = await import("../store/browserStore.ts");
const { LocalFileEngine, LocalFileService } = await import("./localFileService.ts");

const S = () => useBrowser.getState();

// The native side, as a test wants it: what it may read, and what it opens.
const fakeEngine = () => {
  const lab = {
    opened: [],
    inspected: [],
    reconnected: [],
    access: { status: "available", browserReadable: true, url: "file:///Users/me/Documents/notes.md", name: "notes.md" },
  };

  const layer = Layer.succeed(LocalFileEngine)({
    inspect: (path, relativePath) =>
      Effect.sync(() => {
        lab.inspected.push({ path, relativePath });

        return lab.access;
      }),
    open: (path, relativePath) =>
      Effect.sync(() => {
        lab.opened.push({ path, relativePath });

        return lab.access;
      }),
    reconnect: (path, kind) =>
      Effect.sync(() => {
        lab.reconnected.push({ path, kind });

        return true;
      }),
  });

  return { layer, lab };
};

const withService = async (use) => {
  const engine = fakeEngine();
  const runtime = ManagedRuntime.make(LocalFileService.layer.pipe(Layer.provide(AuthorityStore.layer(useBrowser)), Layer.provide(engine.layer)));

  try {
    await use({ lab: engine.lab, runtime });
  } finally {
    await runtime.dispose();
  }
};

const open = (runtime, windowId, pinId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const files = yield* LocalFileService;

      return yield* files.open(windowId, pinId);
    }),
  );

test("a file this Mac may read opens in a tab of the window", async () => {
  await withService(async ({ lab, runtime }) => {
    S().hydrate({});

    const window = S().createWindow({});
    const [pin] = S().pinLocalFiles(window, [{ path: "/Users/me/Documents", name: "Documents", kind: "folder" }]);

    const access = await open(runtime, window, pin);

    assert.equal(access.status, "available");
    assert.equal(lab.opened.length, 1);
    assert.ok(
      Object.values(S().tabs).some((tab) => tab.url === "file:///Users/me/Documents/notes.md"),
      "the file has a tab",
    );
  });
});

test("a private window opens no file", async () => {
  await withService(async ({ lab, runtime }) => {
    S().hydrate({});

    const window = S().createWindow({ incognito: true });
    const [pin] = S().pinLocalFiles(window, [{ path: "/Users/me/Documents", name: "Documents", kind: "folder" }]);

    const access = await open(runtime, window, pin);

    assert.equal(access.status, "inaccessible");
    assert.deepEqual(lab.opened, [], "the native side was not asked");
  });
});

test("a path this Mac may not read keeps its own outcome", async () => {
  await withService(async ({ lab, runtime }) => {
    S().hydrate({});

    const window = S().createWindow({});
    const [pin] = S().pinLocalFiles(window, [{ path: "/Users/me/Documents", name: "Documents", kind: "folder" }]);

    lab.access = { status: "inaccessible" };

    const access = await open(runtime, window, pin);

    assert.equal(access.status, "inaccessible");
    assert.equal(Object.values(S().tabs).filter((tab) => tab.url?.startsWith("file://")).length, 0);
  });
});

test("closing a file's row closes the window's peek of it and the tabs that show it", async () => {
  await withService(async ({ runtime }) => {
    S().hydrate({});

    const window = S().createWindow({ url: "https://example.com/" });
    const [pin] = S().pinLocalFiles(window, [{ path: "/Users/me/Documents", name: "Documents", kind: "folder" }]);
    const url = "file:///Users/me/Documents/notes.md";

    await open(runtime, window, pin);

    const opener = Object.values(S().tabs).find((tab) => tab.url === "https://example.com/");
    const peek = S().openPeek(opener.id, url);

    assert.ok(peek && S().peeks[window], "the file is peeked over the window's page");

    await runtime.runPromise(
      Effect.gen(function* () {
        const files = yield* LocalFileService;

        yield* files.close(window, pin, "notes.md");
      }),
    );

    assert.equal(S().peeks[window], undefined, "the peek closed as a peek");
    assert.equal(Object.values(S().tabs).filter((tab) => tab.url === url).length, 0, "no page shows the file");
    assert.ok(S().tabs[opener.id], "the page the peek was over stays");
  });
});
