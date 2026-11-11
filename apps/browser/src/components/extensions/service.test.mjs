// The extensions (components/extensions/service.ts): the engine's report, the snapshot it gives, the commands the
// app sends it, and the search engines it reconciles.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";

const { useBrowser } = await import("../../store/browserStore.ts");
const { useExtensions } = await import("./store.ts");
const { ExtensionsEngine, ExtensionsService, ExtensionFailure } = await import("./service.ts");
const { fakeDiagnostics } = await import("../../effect/testing.ts");

// The extension the engine has installed.
const extension = (id, name) => ({ id, name, enabled: true });

// The search engines an extension has registered.
const engineList = (id, name) => ({
  engines: [{ name, keyword: name, url: "https://example.com/?q=%s", suggestionsUrl: "", default: false, isOmniboxExtension: false, extension: { id, name } }],
});

// The engine's extensions, as a test wants them: what it answers, and what it was asked.
const fakeEngine = (lab) =>
  Layer.succeed(ExtensionsEngine)({
    list: (profile) =>
      Effect.suspend(() => {
        lab.listed.push(profile);

        if (lab.listFails) {
          return Effect.fail(
            new ExtensionFailure({
              operation: { name: "extensions.list", resource: profile },
              message: "The extensions could not be read.",
              cause: new Error("busy"),
            }),
          );
        }

        return Effect.succeed(lab.installed[profile] ?? []);
      }),
    install: (path, profile) =>
      Effect.suspend(() => {
        lab.installs.push(path);

        if (lab.installFails) {
          return Effect.fail(
            new ExtensionFailure({
              operation: { name: "extensions.install", resource: profile },
              message: "The extension could not be installed.",
              cause: new Error("busy"),
            }),
          );
        }

        return Effect.succeed("ext-1");
      }),
    uninstall: (id) =>
      Effect.suspend(() => {
        lab.removed.push(id);

        return Effect.void;
      }),
    setEnabled: (id, profile, enabled) =>
      Effect.suspend(() => {
        lab.enabled.push({ id, enabled });

        return Effect.void;
      }),
    configure: (id, profile, options) =>
      Effect.suspend(() => {
        lab.configured.push(options);

        return Effect.void;
      }),
    searchEngines: (profile) =>
      Effect.suspend(() => {
        lab.engines.push(profile);

        if (lab.enginesFail) {
          return Effect.fail(
            new ExtensionFailure({
              operation: { name: "extensions.searchEngines", resource: profile },
              message: "The extension's search engines could not be read.",
              cause: new Error("busy"),
            }),
          );
        }

        return Effect.succeed(lab.engineLists[profile] ?? { engines: [] });
      }),
    resolvePrompt: (requestId, accepted) =>
      Effect.suspend(() => {
        lab.prompts.push({ requestId, accepted });

        if (lab.promptFails) {
          return Effect.fail(
            new ExtensionFailure({
              operation: { name: "extensions.prompt", resource: requestId },
              message: "The extension's request could not be answered.",
              cause: new Error("busy"),
            }),
          );
        }

        return Effect.void;
      }),
    onChanged: (listener) =>
      Effect.sync(() => {
        lab.listeners.push(listener);

        return () => {
          const at = lab.listeners.indexOf(listener);

          if (at >= 0) lab.listeners.splice(at, 1);
          lab.givenBack++;
        };
      }),
  });

// The service's work happens in the background: the test waits for it to arrive.
const until = async (what) => {
  for (let i = 0; i < 200; i++) {
    if (what()) return;

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("the service did not answer in time");
};

// A turn of the event loop, so a fiber that was woken gets to run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// A profile of the app's own: a window in a space of its own.
const openProfile = (name) => {
  useBrowser.getState().hydrate({});

  const spaceId = useBrowser.getState().createSpace({ name });

  useBrowser.getState().createWindow({ spaceId, url: "https://example.com/" });

  return spaceId;
};

const withExtensions = async (use) => {
  const lab = {
    configured: [],
    enabled: [],
    engineLists: {},
    engines: [],
    enginesFail: false,
    givenBack: 0,
    installFails: false,
    installed: {},
    installs: [],
    listeners: [],
    listFails: false,
    listed: [],
    prompts: [],
    promptFails: false,
    removed: [],
  };

  const diagnostics = fakeDiagnostics();

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(ExtensionsService.layer.pipe(Layer.provide(fakeEngine(lab)), Layer.provide(diagnostics.layer)), TestClock.layer()),
  );

  useExtensions.setState({ lists: {} });

  try {
    await use({ lab, diagnostics, runtime, service: await runtime.runPromise(ExtensionsService) });
  } finally {
    await runtime.dispose();
  }
};

test("the engine's report is listened to once", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    await runtime.runPromise(service.start);
    await runtime.runPromise(service.start);

    assert.equal(lab.listeners.length, 1, "the report is listened to once");
  });
});

test("the teardown gives every registration back", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    await runtime.runPromise(service.start);

    assert.equal(lab.listeners.length, 1, "the report is listened to");

    await runtime.dispose();

    assert.equal(lab.listeners.length, 0, "the report is not listened to any more");
    assert.equal(lab.givenBack, 1, "the registration was given back once");
  });
});

test("a profile that is read after the teardown is not read at all", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    await runtime.runPromise(service.start);

    await runtime.dispose();

    const read = lab.listed.length;

    openProfile("Later");

    await settle();

    assert.equal(lab.listed.length, read, "the app's windows are not read any more");
  });
});

test("a failed acquisition is reported once, and nothing asks again", async () => {
  await withExtensions(async ({ diagnostics, lab, runtime, service }) => {
    openProfile("Work");

    lab.listFails = true;

    await runtime.runPromise(service.start);
    await until(() => lab.listed.length > 0);
    await settle();

    assert.equal(diagnostics.reports.length, 1, "the failure is reported once");
    assert.equal(diagnostics.reports[0].operation.name, "extensions.list");
    assert.equal(lab.listed.length, 1, "the engine is not asked again");
  });
});

test("a refused permission is not asked again", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    await runtime.runPromise(service.answer("req-1", false));
    await runtime.runPromise(service.answer("req-1", false));

    assert.equal(lab.prompts.length, 1, "the engine is asked once");
    assert.equal(lab.prompts[0].accepted, false, "the refusal was passed on");
  });
});

test("a permission that could not be answered is not tried again", async () => {
  await withExtensions(async ({ diagnostics, lab, runtime, service }) => {
    lab.promptFails = true;

    await runtime.runPromise(service.answer("req-1", false));
    await runtime.runPromise(service.answer("req-1", false));

    assert.equal(lab.prompts.length, 1, "the engine is asked once");
    assert.equal(diagnostics.reports.length, 1, "the failure is reported once");
  });
});

test("a native change reconciles the search engines once", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    const profile = openProfile("Work");

    await runtime.runPromise(service.start);
    await until(() => lab.listed.length > 0);

    // The first reconciliation of a profile waits for the engine to register the extension's search engine.
    await settle();
    await runtime.runPromise(TestClock.adjust(3000));
    await until(() => lab.engines.length > 0);

    const read = lab.engines.length;

    // The engine says the profile's extensions changed.
    lab.listeners[0]({ profile, id: "ext-1", event: "installed" });

    await until(() => lab.listed.length > 1);
    await settle();
    await runtime.runPromise(TestClock.adjust(400));
    await until(() => lab.engines.length > read);

    assert.equal(lab.engines.length, read + 1, "the search engines are reconciled once");
  });
});

test("a native change that comes while a reconciliation waits is reconciled once", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    const profile = openProfile("Work");

    await runtime.runPromise(service.start);
    await until(() => lab.listed.length > 0);

    await settle();
    await runtime.runPromise(TestClock.adjust(3000));
    await until(() => lab.engines.length > 0);

    const read = lab.engines.length;

    lab.listeners[0]({ profile, id: "ext-1", event: "installed" });
    lab.listeners[0]({ profile, id: "ext-1", event: "enabled" });

    await until(() => lab.listed.length > 2);
    await settle();
    await runtime.runPromise(TestClock.adjust(400));
    await until(() => lab.engines.length > read);

    assert.equal(lab.engines.length, read + 1, "the search engines are reconciled once");
  });
});

test("two profiles never mix", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    const first = openProfile("First");
    const second = openProfile("Second");

    lab.installed[first] = [extension("a", "Alpha")];
    lab.installed[second] = [extension("b", "Beta")];
    lab.engineLists[first] = engineList("a", "Alpha");
    lab.engineLists[second] = engineList("b", "Beta");

    await runtime.runPromise(service.refresh(first));
    await runtime.runPromise(service.refresh(second));

    const lists = useExtensions.getState().lists;

    assert.deepEqual(
      lists[first].map((x) => x.id),
      ["a"],
      "the first profile has its own extensions",
    );
    assert.deepEqual(
      lists[second].map((x) => x.id),
      ["b"],
      "the second profile has its own extensions",
    );

    await settle();
    await runtime.runPromise(TestClock.adjust(3000));
    await until(() => lab.engines.length >= 2);

    const engines = useBrowser.getState().settings.extensionSearchEngines ?? [];

    assert.deepEqual(engines.map((engine) => engine.profile).sort(), [first, second].sort(), "each profile keeps its own search engines");
  });
});

test("a command that fails is named, and the profile is not read again", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    const profile = openProfile("Work");

    lab.installFails = true;

    const exit = await runtime.runPromise(Effect.exit(service.install("/tmp/extension", profile)));

    assert.equal(Exit.isFailure(exit), true, "the command failed");

    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;

    assert.equal(failure.operation.name, "extensions.install", "the failure names what was done");
    assert.equal(lab.listed.length, 0, "the profile is not read when the command failed");
  });
});

test("a command that goes through reads the profile again", async () => {
  await withExtensions(async ({ lab, runtime, service }) => {
    const profile = openProfile("Work");

    await runtime.runPromise(service.install("/tmp/extension", profile));

    assert.deepEqual(lab.installs, ["/tmp/extension"], "the engine was asked to install it");
    assert.deepEqual(lab.listed, [profile], "the profile was read again");
  });
});
