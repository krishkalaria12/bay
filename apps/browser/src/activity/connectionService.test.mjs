// The account connections (activity/connectionService.ts): the OAuth tab, the device poll, the Keychain and the
// tokens.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { ConnectionEngine, ConnectionService } = await import("./connectionService.ts");
const { LiveError } = await import("./types.ts");
const { endpoints } = await import("./net.ts");
const { GOOGLE_REDIRECT } = await import("./constants.ts");
const { live } = await import("./activityStore.ts");
const { fakeDiagnostics } = await import("../effect/testing.ts");

const GOOGLE_TOKEN = endpoints.googleToken;
const DEVICE_CODE = `${endpoints.githubWeb}/login/device/code`;
const DEVICE_TOKEN = `${endpoints.githubWeb}/login/oauth/access_token`;

// The engine a test drives: the Keychain, the network and the tabs are all the test's own.
const fakeEngine = (lab) =>
  Layer.succeed(ConnectionEngine)({
    readSecret: (source) => Effect.sync(() => lab.secrets.get(source) ?? null),
    writeSecret: (source, secret) =>
      Effect.sync(() => {
        lab.secrets.set(source, secret);
        lab.writes.push(source);
      }),
    deleteSecret: (source) =>
      Effect.sync(() => {
        lab.secrets.delete(source);
        lab.deletes.push(source);
      }),
    send: (req) =>
      Effect.suspend(() => {
        lab.requests.push(req);

        const answer = lab.answers.get(req.url);

        if (answer === undefined) return Effect.fail(new LiveError("network", "Couldn't connect"));

        if (answer instanceof Error) return Effect.fail(answer);

        // A request the test holds: nothing comes back until it lets go.
        if (lab.gate) return Effect.promise(() => lab.gate.promise).pipe(Effect.map(() => answer));

        return Effect.succeed(answer);
      }),
    openTab: (windowId, url) =>
      Effect.sync(() => {
        const id = `tab-${lab.opened.length + 1}`;

        lab.opened.push({ id, url, windowId });

        return id;
      }),
    closeTab: (tabId) =>
      Effect.sync(() => {
        lab.closed.push(tabId);
      }),
    watchTab: (tabId, listener) => {
      lab.watchers.push({ tabId, listener });

      return () => {
        lab.stopped.push(tabId);
      };
    },
  });

const withConnections = async (use) => {
  const lab = {
    answers: new Map(),
    closed: [],
    deletes: [],
    gate: null,
    opened: [],
    requests: [],
    secrets: new Map(),
    stopped: [],
    watchers: [],
    writes: [],
  };

  const diagnostics = fakeDiagnostics();

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(ConnectionService.layer.pipe(Layer.provide(Layer.mergeAll(fakeEngine(lab), diagnostics.layer))), TestClock.layer()),
  );

  const work = (program) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* ConnectionService;

        return yield* program(service);
      }),
    );

  try {
    await use({ lab, runtime, work, diagnostics });
  } finally {
    await runtime.dispose();
  }
};

// The fibers get a turn.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const googleTokens = (accessToken, expiresAt = 0) =>
  JSON.stringify({ access_token: accessToken, refresh_token: "refresh-token", expires_at: expiresAt, client_secret: "client-secret" });

test("the sign-in tab goes with the flow when the user closes it", async () => {
  await withConnections(async ({ lab, work }) => {
    const connecting = work((service) => service.signInWithGoogle("w1", "client-id", "client-secret"));

    await tick();

    assert.equal(lab.opened.length, 1, "the sign-in opened its tab");
    assert.equal(lab.watchers.length, 1, "the flow watched the tab");

    // The user closed the tab.
    lab.watchers[0].listener(null);

    await assert.rejects(connecting, /Sign-in was cancelled/);

    assert.deepEqual(lab.stopped, ["tab-1"], "the flow let the tab go");
    assert.deepEqual(lab.closed, ["tab-1"], "the tab went with the flow");
  });
});

test("a sign-in that is replaced ends the first one, and its tab", async () => {
  await withConnections(async ({ lab, work }) => {
    const first = work((service) => service.signInWithGoogle("w1", "client-id", "client-secret"));
    const firstEnded = assert.rejects(first, /Cancelled/);

    await tick();

    const second = work((service) => service.signInWithGoogle("w1", "client-id", "client-secret"));

    // The second flow waits for a redirect that never comes.
    second.catch(() => {});

    await tick();

    await firstEnded;

    assert.deepEqual(lab.stopped, ["tab-1"], "the first flow let its tab go");
    assert.deepEqual(lab.closed, ["tab-1"], "the first tab went with it");
    assert.equal(lab.opened.length, 2, "the second flow opened its own tab");
  });
});

test("a redirect that is not this request's does not connect", async () => {
  await withConnections(async ({ lab, work }) => {
    const connecting = work((service) => service.signInWithGoogle("w1", "client-id", "client-secret"));

    await tick();

    lab.watchers[0].listener(`${GOOGLE_REDIRECT}?code=the-code&state=another-request`);

    await assert.rejects(connecting, /Sign-in didn't match this request/);

    assert.equal(lab.requests.length, 0, "nothing was asked of the provider");
    assert.equal(lab.secrets.size, 0, "nothing was kept");
  });
});

test("a redirect that is this request's connects the account", async () => {
  await withConnections(async ({ lab, work }) => {
    lab.answers.set(GOOGLE_TOKEN, { access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
    lab.answers.set(`${endpoints.drive}/about?fields=user`, { user: { displayName: "Bay", emailAddress: "bay@example.com" } });

    const connecting = work((service) => service.signInWithGoogle("w1", "client-id", "client-secret"));

    await tick();

    const state = new URL(lab.opened[0].url).searchParams.get("state");

    lab.watchers[0].listener(`${GOOGLE_REDIRECT}?code=the-code&state=${state}`);

    await connecting;

    assert.deepEqual(lab.writes, ["gdrive"], "the tokens were kept");
    assert.equal(live().accounts.gdrive?.login, "bay@example.com");
    assert.deepEqual(lab.closed, ["tab-1"], "the tab went with the flow");
  });
});

test("a disconnected account is not brought back by a late refresh", async () => {
  await withConnections(async ({ lab, work }) => {
    lab.secrets.set("gdrive", googleTokens("old-token"));
    lab.answers.set(GOOGLE_TOKEN, { access_token: "fresh-token", expires_in: 3600 });

    lab.gate = Promise.withResolvers();

    const refreshing = work((service) => service.token("gdrive"));

    await tick();

    assert.equal(lab.requests.length, 1, "the refresh was asked for");

    // The account is disconnected while the token is on its way.
    await work((service) => service.disconnect("gdrive"));

    lab.gate.resolve();

    await assert.rejects(refreshing);

    assert.equal(lab.secrets.has("gdrive"), false, "the disconnected account was not written back");
    assert.equal(live().accounts.gdrive, undefined, "the disconnected account is not connected");
  });
});

test("the refresh of an account is one at a time", async () => {
  await withConnections(async ({ lab, work }) => {
    lab.secrets.set("gdrive", googleTokens("old-token"));
    lab.answers.set(GOOGLE_TOKEN, { access_token: "fresh-token", expires_in: 3600 });

    lab.gate = Promise.withResolvers();

    const first = work((service) => service.token("gdrive"));
    const second = work((service) => service.token("gdrive"));

    await tick();

    assert.equal(lab.requests.length, 1, "the second reader waited for the first");

    lab.gate.resolve();

    const tokens = await Promise.all([first, second]);

    assert.deepEqual(tokens, ["fresh-token", "fresh-token"]);
    assert.equal(lab.requests.length, 1, "the token was refreshed once");
  });
});

test("a device flow waits for the code and connects the account", async () => {
  await withConnections(async ({ lab, runtime, work }) => {
    lab.answers.set(DEVICE_CODE, {
      device_code: "device-code",
      user_code: "USER-CODE",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    lab.answers.set(DEVICE_TOKEN, { access_token: "ghp_token" });
    lab.answers.set(endpoints.githubGraphql, { data: { viewer: { login: "bay", name: "Bay", avatarUrl: "avatar" } } });

    const flow = await work((service) => service.deviceFlow("client-id"));

    assert.equal(flow.userCode, "USER-CODE");
    assert.equal(flow.verificationUri, "https://github.com/login/device");

    await tick();
    await runtime.runPromise(TestClock.adjust(5000));

    await work(() => flow.done);

    assert.deepEqual(lab.writes, ["github"], "the token was kept");
    assert.equal(live().accounts.github?.login, "bay");
  });
});

test("a device flow that is cancelled stops waiting", async () => {
  await withConnections(async ({ lab, runtime, work }) => {
    lab.answers.set(DEVICE_CODE, {
      device_code: "device-code",
      user_code: "USER-CODE",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });

    const flow = await work((service) => service.deviceFlow("client-id"));

    await tick();

    await work(() => flow.cancel);

    await assert.rejects(
      work(() => flow.done),
      /Cancelled/,
    );

    await runtime.runPromise(TestClock.adjust(5000));

    assert.equal(lab.requests.length, 1, "the flow only asked for the code");
  });
});

test("a token never reaches a diagnostic", async () => {
  await withConnections(async ({ lab, runtime, work, diagnostics }) => {
    lab.answers.set(DEVICE_CODE, {
      device_code: "device-code",
      user_code: "USER-CODE",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    lab.answers.set(DEVICE_TOKEN, { access_token: "ghp_the_token" });
    // The provider answers with the token it was given.
    lab.answers.set(endpoints.githubGraphql, new LiveError("other", "the token ghp_the_token was not accepted"));

    const flow = await work((service) => service.deviceFlow("client-id"));

    await tick();
    await runtime.runPromise(TestClock.adjust(5000));

    await assert.rejects(work(() => flow.done));

    assert.equal(diagnostics.reports.length > 0, true, "the failure was reported");

    for (const report of diagnostics.reports) {
      assert.equal(JSON.stringify(report).includes("ghp_the_token"), false, "the token was in the report");
    }
  });
});
