import { AuthorityStore } from "../effect/ports/store.ts";
// The download work (lib/downloadWorkService.ts): the rename, the way back, and the once-per-download rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { useBrowser } = await import("../store/browserStore.ts");
const { DownloadEngine, DownloadWorkService } = await import("./downloadWorkService.ts");

const S = () => useBrowser.getState();

// The Mac's side of the downloads, as a test wants it.
const fakeEngine = () => {
  const lab = {
    renamed: [],
    suggested: null,
    fails: false,
    // Where the file system put the file, when the test says.
    result: null,
  };

  const layer = Layer.succeed(DownloadEngine)({
    rename: (path, filename) =>
      Effect.suspend(() => {
        if (lab.fails) return Effect.fail({ operation: "download.rename", cause: new Error("no") });

        lab.renamed.push({ path, filename });

        return Effect.succeed(lab.result ?? `${path}/${filename}`);
      }),
    suggest: () => Effect.sync(() => lab.suggested),
  });

  return { layer, lab };
};

const withWork = async (use) => {
  const engine = fakeEngine();
  const runtime = ManagedRuntime.make(DownloadWorkService.layer.pipe(Layer.provide(AuthorityStore.layer(useBrowser)), Layer.provide(engine.layer)));

  try {
    await use({ lab: engine.lab, runtime });
  } finally {
    await runtime.dispose();
  }
};

const download = (windowId) => {
  const d = {
    id: "d1",
    url: "https://example.com/report.pdf",
    filename: "IMG_20261024_8812.pdf",
    suggestedFilename: "report.pdf",
    state: "finished",
    paused: false,
    received: 1,
    total: 1,
    speed: 0,
    path: "/tmp/report.pdf",
    mimeType: "application/pdf",
    tabUrl: "https://acme.com/reports",
  };

  if (windowId !== undefined) d.windowId = windowId;

  return d;
};

test("a renamed download keeps the name the file system gave it", async () => {
  await withWork(async ({ lab, runtime }) => {
    S().hydrate({});
    const window = S().createWindow({});

    S().upsertDownload(download(window));

    const path = await runtime.runPromise(
      Effect.gen(function* () {
        const work = yield* DownloadWorkService;

        return yield* work.rename(download(), { filename: "Report.pdf", value: null, kind: "file" });
      }),
    );

    assert.equal(path, "/tmp/report.pdf/Report.pdf");
    assert.deepEqual(lab.renamed, [{ path: "/tmp/report.pdf", filename: "Report.pdf" }]);
    assert.equal(S().downloads.find((d) => d.id === "d1").filename, "Report.pdf");
  });
});

test("a renamed download on Windows takes the file's name, not its folder path", async () => {
  await withWork(async ({ lab, runtime }) => {
    S().hydrate({});
    const window = S().createWindow({});
    const d = { ...download(window), path: "C:\\Users\\me\\Downloads\\IMG_20261024_8812.pdf" };

    S().upsertDownload(d);
    lab.result = "C:\\Users\\me\\Downloads\\Report.pdf";

    await runtime.runPromise(
      Effect.gen(function* () {
        const work = yield* DownloadWorkService;

        return yield* work.rename(d, { filename: "Report.pdf", value: null, kind: "file" });
      }),
    );

    assert.equal(S().downloads.find((x) => x.id === "d1").filename, "Report.pdf");
  });
});

test("a download that cannot be renamed keeps its own name", async () => {
  await withWork(async ({ lab, runtime }) => {
    S().hydrate({});
    lab.fails = true;

    const path = await runtime.runPromise(
      Effect.gen(function* () {
        const work = yield* DownloadWorkService;

        return yield* work.rename(download(), { filename: "Report.pdf", value: null, kind: "file" });
      }).pipe(Effect.catch(() => Effect.succeed("failed"))),
    );

    assert.equal(path, "failed");
  });
});

test("a download the user named is left alone", async () => {
  await withWork(async ({ lab, runtime }) => {
    S().hydrate({});
    S().updateSettings({ tidyDownloads: true });
    const window = S().createWindow({ url: "https://acme.com/reports" });

    S().upsertDownload(download(window));

    const named = await runtime.runPromise(
      Effect.gen(function* () {
        const work = yield* DownloadWorkService;

        return yield* work.finish(download(window));
      }),
    );

    assert.equal(named, null, "a name that needs no help is left as it is");
    assert.deepEqual(lab.renamed, []);
  });
});
