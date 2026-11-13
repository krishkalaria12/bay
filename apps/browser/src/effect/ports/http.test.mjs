// The network port (effect/ports/http.ts): the app's requests, their status, and the decoding of what comes back.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { Http } = await import("./http.ts");

const runtime = ManagedRuntime.make(Http.layer);

const withHttp = (use) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const http = yield* Http;

      return yield* use(http);
    }),
  );

const stubFetch = (answer) => {
  const original = globalThis.fetch;

  globalThis.fetch = answer;

  return () => {
    globalThis.fetch = original;
  };
};

test("a request that comes back carries its status and its body", async () => {
  const restore = stubFetch(async () => new Response("hello", { status: 200 }));

  try {
    const response = await withHttp((http) => http.send({ url: "https://example.test/greeting" }));

    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.equal(response.body, "hello");
  } finally {
    restore();
  }
});

test("a status that isn't a success is a typed failure that keeps the status", async () => {
  const restore = stubFetch(async () => new Response("gone", { status: 404 }));

  try {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const http = yield* Http;

        return yield* http.send({ url: "https://example.test/missing" });
      }),
    );

    assert.equal(exit._tag, "Failure");

    const failure = Cause.squash(exit.cause);

    assert.equal(failure._tag, "HttpError");
    assert.equal(failure.status, 404);
  } finally {
    restore();
  }
});

test("a rate limit keeps the wait the server asked for", async () => {
  const restore = stubFetch(async () => new Response("", { status: 429, headers: { "retry-after": "30" } }));

  try {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const http = yield* Http;

        return yield* http.send({ url: "https://example.test/busy" });
      }),
    );

    assert.equal(exit._tag, "Failure");

    const failure = Cause.squash(exit.cause);

    assert.equal(failure._tag, "HttpError");
    assert.equal(failure.status, 429);
    assert.equal(failure.retryAfterMs, 30_000);
  } finally {
    restore();
  }
});

test("a body is decoded at the edge where it arrives", async () => {
  const restore = stubFetch(async () => new Response('{"name":"Ada"}', { status: 200 }));

  try {
    const name = await withHttp((http) => http.sendJson({ url: "https://example.test/user" }, (body) => JSON.parse(body).name));

    assert.equal(name, "Ada");
  } finally {
    restore();
  }
});

test("a body that is not what was expected is a typed failure", async () => {
  const restore = stubFetch(async () => new Response("not json", { status: 200 }));

  try {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const http = yield* Http;

        return yield* http.sendJson({ url: "https://example.test/user" }, (body) => JSON.parse(body).name);
      }),
    );

    assert.equal(exit._tag, "Failure");
  } finally {
    restore();
  }
});

test("an interrupted request is cancelled", async () => {
  let aborted = false;

  const restore = stubFetch(async (_url, options) => {
    options.signal.addEventListener("abort", () => {
      aborted = true;
    });

    return new Promise(() => {});
  });

  try {
    const fiber = runtime.runFork(
      Effect.gen(function* () {
        const http = yield* Http;

        return yield* http.send({ url: "https://example.test/slow" });
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(aborted, true);
  } finally {
    restore();
  }
});
