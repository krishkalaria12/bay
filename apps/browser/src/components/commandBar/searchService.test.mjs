// The search service (components/commandBar/searchService.ts): what may be asked of the engine, what answers, and
// what is dropped.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { SearchNetwork, SearchService } = await import("./searchService.ts");

// The engine the test asks: its suggestions come from its own address.
const ENGINE = { id: "test", name: "Test", keyword: "test", url: "https://test.example/?q=%s", suggestUrl: "https://test.example/suggest?q=%s" };

// The suggestions the engine answers with, as the payload the shared fetcher reads.
const suggestions = (list) => JSON.stringify(["test", list]);

// The rates the currency providers answer with.
const RATES = JSON.stringify({ rates: { INR: 83 }, date: "2026-10-15" });

// The network, as a test wants it: the requests it was asked for, and the answers it gives when the test lets it.
const fakeNetwork = () => {
  const fake = {
    /** The requests the network was asked for. */
    requests: [],
    /** Whether the requests wait for the test to give them their answer. */
    holding: false,
    /** The answers the network gives, by URL. */
    answers: new Map(),
  };

  const layer = Layer.succeed(SearchNetwork)({
    fetch: (url, signal, request) =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            const asked = {
              url,
              signal,
              /** The headers and the cookie policy the request carried. */
              request,
              /** Gives the request its answer. */
              give: (body) => resolve({ status: 200, ok: true, body, headers: { get: () => null } }),
            };

            fake.requests.push(asked);

            if (!fake.holding) asked.give("");
          }),
      ),
  });

  return { layer, fake };
};

// Waits for the work to reach the network, which the shared fetcher does after its debounce.
const until = async (what, ready) => {
  const deadline = Date.now() + 5000;

  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const withService = async (network, use) => {
  const runtime = ManagedRuntime.make(SearchService.layer.pipe(Layer.provide(network.layer)));

  try {
    await use(runtime);
  } finally {
    await runtime.dispose();
  }
};

const suggest = (runtime, session, request) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const search = yield* SearchService;

      yield* search.suggest(session, request);
    }),
  );

const convert = (runtime, session, request) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const search = yield* SearchService;

      yield* search.convert(session, request);
    }),
  );

const close = (runtime, session) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const search = yield* SearchService;

      yield* search.close(session);
    }),
  );

test("an older query's answer never replaces a newer one", async () => {
  const network = fakeNetwork();

  network.fake.holding = true;

  await withService(network, async (runtime) => {
    const answers = [];

    await suggest(runtime, "bar", { engine: ENGINE, query: "a", policy: "ask", onResult: (list) => answers.push(["a", list]) });

    await until("the first request", () => network.fake.requests.length === 1);

    await suggest(runtime, "bar", { engine: ENGINE, query: "ab", policy: "ask", onResult: (list) => answers.push(["ab", list]) });

    await until("the second request", () => network.fake.requests.length === 2);

    // The first answer arrives late: it belongs to the query that was typed before.
    network.fake.requests[0].give(suggestions(["alpha"]));
    await settle();

    assert.deepEqual(answers, [], "the older answer is dropped");

    network.fake.requests[1].give(suggestions(["able"]));
    await until("the answer", () => answers.length === 1);

    assert.deepEqual(answers, [["ab", ["able"]]], "the newer answer is the one that is shown");
  });
});

test("an older conversion never replaces a newer one", async () => {
  const network = fakeNetwork();

  network.fake.holding = true;

  await withService(network, async (runtime) => {
    const answers = [];

    await convert(runtime, "bar", { expression: "100 usd in inr", policy: "ask", onResult: (answer) => answers.push(answer) });

    await until("the first rate request", () => network.fake.requests.length === 1);

    await convert(runtime, "bar", { expression: "10 eur in inr", policy: "ask", onResult: (answer) => answers.push(answer) });

    await until("the second rate request", () => network.fake.requests.length === 2);

    // The first answer arrives late: it belongs to the expression that was typed before.
    network.fake.requests[0].give(RATES);
    await settle();

    assert.deepEqual(answers, [], "the older answer is dropped");

    network.fake.requests[1].give(RATES);
    await until("the answer", () => answers.length === 1);

    assert.equal(answers[0].value, 830, "the newer answer is the one that is shown");
  });
});

test("closing the palette cancels the work", async () => {
  const network = fakeNetwork();

  network.fake.holding = true;

  await withService(network, async (runtime) => {
    const answers = [];

    await suggest(runtime, "bar", { engine: ENGINE, query: "a", policy: "ask", onResult: (list) => answers.push(list) });

    await until("the request", () => network.fake.requests.length === 1);

    await close(runtime, "bar");

    assert.equal(network.fake.requests[0].signal.aborted, true, "the request in flight is stopped");

    // An answer that arrives after the palette closed is not shown.
    network.fake.requests[0].give(suggestions(["alpha"]));
    await settle();

    assert.deepEqual(answers, [], "nothing answers a palette that has closed");
  });
});

test("a disabled or private search policy sends nothing", async () => {
  const network = fakeNetwork();

  await withService(network, async (runtime) => {
    await suggest(runtime, "bar", { engine: ENGINE, query: "a", policy: "off", onResult: () => {} });
    await suggest(runtime, "bar", { engine: ENGINE, query: "a", policy: "private", onResult: () => {} });

    // The shared fetcher would have asked by now, if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.deepEqual(network.fake.requests, [], "nothing typed leaves the machine");

    // The policy is what stopped it: the same request is asked when the search may be made.
    await suggest(runtime, "bar", { engine: ENGINE, query: "a", policy: "ask", onResult: () => {} });

    await until("the request", () => network.fake.requests.length === 1);
  });
});

test("two command bars keep their own work", async () => {
  const network = fakeNetwork();

  network.fake.holding = true;

  await withService(network, async (runtime) => {
    await suggest(runtime, "one", { engine: ENGINE, query: "a", policy: "ask", onResult: () => {} });

    await until("the first request", () => network.fake.requests.length === 1);

    await suggest(runtime, "two", { engine: ENGINE, query: "b", policy: "ask", onResult: () => {} });

    await until("the second request", () => network.fake.requests.length === 2);

    assert.equal(network.fake.requests[0].signal.aborted, false, "one command bar does not stop another's work");
  });
});

test("the bang list is asked for without cookies, and with the version it has", async () => {
  const network = fakeNetwork();

  await withService(network, async (runtime) => {
    const reply = await runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* SearchService;

        return yield* search.bangList("etag-1");
      }),
    );

    const asked = network.fake.requests[0];

    assert.equal(asked.request.credentials, "omit", "the bang list carries no cookies");
    assert.equal(asked.request.headers["If-None-Match"], "etag-1", "the list is asked for by the version the app has");
    assert.equal(reply.status, 200, "the answer is the one the server gave");
    assert.equal(reply.body, "", "the body comes back whole");
  });
});

test("off the Mac, suggestions go through the engine in the profile that registered the engine", async () => {
  const network = fakeNetwork();
  const asked = [];

  const layer = Layer.succeed(SearchNetwork)({
    fetch: () => Effect.die(new Error("the page's fetch is not used when the engine answers")),
    suggest: async (profile, url, client) => {
      asked.push({ profile, url, client });

      return { body: suggestions(["from the engine"]) };
    },
  });

  await withService({ ...network, layer }, async (runtime) => {
    const answers = [];

    await suggest(runtime, "bar", { engine: ENGINE, query: "a", policy: "ask", profile: "work", client: "window-1", onResult: (list) => answers.push(list) });

    await until("the engine's answer", () => answers.length === 1);

    assert.deepEqual(asked, [{ profile: "work", url: "https://test.example/suggest?q=a", client: "window-1" }]);
    assert.deepEqual(answers, [["from the engine"]]);

    // An extension's engine whose profile is gone is not asked in another.
    await suggest(runtime, "bar", { engine: ENGINE, query: "b", policy: "ask", profile: null, client: "window-1", onResult: (list) => answers.push(list) });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(asked.length, 1);
    assert.equal(answers.length, 1);
  });
});
