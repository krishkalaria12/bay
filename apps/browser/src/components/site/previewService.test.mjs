import { useBrowser } from "../../store/browserStore.ts";
import { ReadBrowser } from "../../effect/windowPorts.ts";
// The link preview (components/site/previewService.ts): what a hovered link says about the page it points at.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { fakeHttp } = await import("../../effect/testing.ts");
const { PreviewEngine, PreviewService } = await import("./previewService.ts");

// A link preview never asks a page: the page is there only for the site previews.
const noPages = Layer.succeed(PreviewEngine)({ fetch: () => Effect.succeed(null) });

const withPreview = async (use) => {
  const http = fakeHttp();

  const runtime = ManagedRuntime.make(
    PreviewService.layer.pipe(Layer.provide(ReadBrowser.layer(useBrowser)), Layer.provide(Layer.mergeAll(http.layer, noPages))),
  );

  try {
    await use({ http, runtime });
  } finally {
    await runtime.dispose();
  }
};

const summary = (runtime, url) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const preview = yield* PreviewService;

      return yield* preview.summary(url);
    }),
  );

test("a page's title, description and first paragraph make its summary", async () => {
  await withPreview(async ({ http, runtime }) => {
    http.answer("https://example.com/", {
      status: 200,
      ok: true,
      body: "<html><head><title>Example</title><meta name='description' content='A page about examples'></head><body><p>The body of the page.</p></body></html>",
      headers: { get: (name) => (name === "content-type" ? "text/html; charset=utf-8" : null) },
    });

    const text = await summary(runtime, "https://example.com/");

    assert.match(text, /Example/);
    assert.match(text, /A page about examples/);
    assert.match(text, /The body of the page/);
  });
});

test("a page that is not HTML has no summary", async () => {
  await withPreview(async ({ http, runtime }) => {
    http.answer("https://example.com/thing.pdf", { status: 200, ok: true, body: "%PDF" });

    const text = await summary(runtime, "https://example.com/thing.pdf");

    assert.equal(text, "No summary available.");
    assert.equal(http.requests.length, 0, "a file was never fetched");
  });
});

test("a page that cannot be reached says so", async () => {
  await withPreview(async ({ http, runtime }) => {
    http.fail("https://example.com/", new Error("offline"));

    const text = await summary(runtime, "https://example.com/");

    assert.equal(text, "Couldn't load a preview for this link.");
  });
});

test("the preview is fetched without the user's cookies", async () => {
  await withPreview(async ({ http, runtime }) => {
    http.answer("https://example.com/", { status: 200, ok: true, body: "<title>Example</title>", headers: { get: () => "text/html" } });

    await summary(runtime, "https://example.com/");

    assert.equal(http.requests[0].credentials, "omit");
  });
});
