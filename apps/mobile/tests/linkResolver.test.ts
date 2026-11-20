// Where a link goes (src/browser/linkResolver.ts): closing the menu aborts the request, the hop-by-hop walk stops at
// ten, and the whole answer has ten seconds.
import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { LinkResolver, MAX_REDIRECTS, RESOLVE_TIMEOUT } from "../src/browser/linkResolver.ts";
import { Http, HttpError, type HttpProbe, type HttpRequest } from "../src/effect/ports/http.ts";
import { fakeHttp, testClockLayer } from "../src/effect/testing.ts";

const noHeaders = { get: () => null };

/** A network that answers probes with `answer`, or never answers at all; it records what was asked and aborted. */
const scriptedHttp = (answer: ((request: HttpRequest) => HttpProbe | Error) | null) => {
  const requests: HttpRequest[] = [];
  const aborted: string[] = [];

  const base = Effect.runSync(
    Effect.provide(
      Http.useSync((http) => http),
      fakeHttp().layer,
    ),
  );

  return {
    layer: Layer.succeed(Http)({
      ...base,
      probe: (request) =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<HttpProbe>((resolve, reject) => {
              requests.push(request);

              signal.addEventListener("abort", () => {
                aborted.push(request.url);
                reject(new Error("aborted"));
              });

              if (!answer) return;

              const result = answer(request);

              if (result instanceof Error) reject(result);
              else resolve(result);
            }),
          catch: (cause) => new HttpError({ operation: { name: "http.probe", resource: request.url }, status: 0, cause }),
        }),
    }),
    requests,
    aborted,
  };
};

const resolverLayer = (http: Layer.Layer<Http>) => LinkResolver.layer.pipe(Layer.provide(http));

test("closing the menu aborts the request it was waiting on", async () => {
  const http = scriptedHttp(null);

  await Effect.runPromise(
    Effect.gen(function* () {
      // The menu's scope, as useScopedWork makes it.
      const menu = yield* Scope.make();
      const resolver = yield* LinkResolver;
      const fiber = yield* Effect.forkIn(resolver.resolve("https://short.example/abc"), menu);

      yield* Effect.yieldNow;
      assert.equal(http.requests.length, 1, "the request is out");

      yield* Scope.close(menu, Exit.void);

      const exit = yield* Fiber.await(fiber);

      assert.ok(Exit.isFailure(exit), "the resolve was interrupted");
      assert.deepEqual(http.aborted, ["https://short.example/abc"], "the network saw the abort");
    }).pipe(Effect.provide(resolverLayer(http.layer))),
  );
});

test("a link that follows in one request answers with where it ended", async () => {
  const http = scriptedHttp((request) => ({
    status: 200,
    url: request.url === "https://short.example/abc" ? "https://long.example/page" : request.url,
    headers: noHeaders,
  }));

  const destination = await Effect.runPromise(
    LinkResolver.use((resolver) => resolver.resolve("https://short.example/abc")).pipe(Effect.provide(resolverLayer(http.layer))),
  );

  assert.equal(destination, "https://long.example/page");
});

test("a server that refuses HEAD is asked again with GET", async () => {
  const http = scriptedHttp((request) =>
    request.method === "HEAD" ? { status: 405, url: request.url, headers: noHeaders } : { status: 200, url: "https://long.example/page", headers: noHeaders },
  );

  const destination = await Effect.runPromise(
    LinkResolver.use((resolver) => resolver.resolve("https://short.example/abc")).pipe(Effect.provide(resolverLayer(http.layer))),
  );

  assert.equal(destination, "https://long.example/page");
  assert.deepEqual(
    http.requests.map((request) => request.method ?? "GET"),
    ["HEAD", "GET"],
  );
});

test("when the followed request fails, the walk goes hop by hop and stops at ten", async () => {
  // Every hop redirects to the next one, for ever; following them in one request fails as App Transport Security does.
  const http = scriptedHttp((request) => {
    if (request.redirect !== "manual") return new Error("App Transport Security refused a plain-http hop");

    const hop = Number(new URL(request.url).searchParams.get("hop") ?? "0");

    return { status: 302, url: request.url, headers: { get: (name: string) => (name === "location" ? `/next?hop=${hop + 1}` : null) } };
  });

  const destination = await Effect.runPromise(
    LinkResolver.use((resolver) => resolver.resolve("https://loop.example/start")).pipe(Effect.provide(resolverLayer(http.layer))),
  );

  const walked = http.requests.filter((request) => request.redirect === "manual");

  assert.equal(walked.length, MAX_REDIRECTS, "the walk asks ten times and no more");
  assert.equal(destination, `https://loop.example/next?hop=${MAX_REDIRECTS}`);
});

test("the hop that can't be loaded is where the link goes, and a link that can't be reached at all has no answer", async () => {
  const http = scriptedHttp((request) => {
    if (request.redirect !== "manual") return new Error("refused");

    if (request.url === "https://short.example/abc") return { status: 301, url: request.url, headers: { get: () => "http://plain.example/page" } };

    return new Error("refused");
  });

  const destination = await Effect.runPromise(
    LinkResolver.use((resolver) => resolver.resolve("https://short.example/abc")).pipe(Effect.provide(resolverLayer(http.layer))),
  );

  assert.equal(destination, "http://plain.example/page");

  const unreachable = await Effect.runPromise(
    LinkResolver.use((resolver) => resolver.resolve("https://down.example/")).pipe(Effect.provide(resolverLayer(http.layer))),
  );

  assert.equal(unreachable, null);
});

test("a link that doesn't answer in ten seconds has no answer, and its request is aborted", async () => {
  const http = scriptedHttp(null);

  const destination = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(LinkResolver.use((resolver) => resolver.resolve("https://slow.example/")));

      yield* Effect.yieldNow;
      yield* TestClock.adjust(RESOLVE_TIMEOUT);

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.merge(resolverLayer(http.layer), testClockLayer))),
  );

  assert.equal(destination, null);
  assert.deepEqual(http.aborted, ["https://slow.example/"]);
});
