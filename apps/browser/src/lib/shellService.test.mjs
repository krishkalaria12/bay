const { useBrowser } = await import("../store/browserStore.ts");

import { AuthorityStore } from "../effect/ports/store.ts";
// The native shell (lib/shellService.ts): the listeners it registers, what it does with them, and what happens when
// the Mac does not answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

globalThis.__DEV__ = false;

const { ShellEngine, ShellFailure, ShellService } = await import("./shellService.ts");
const { Diagnostics } = await import("../effect/ports/diagnostics.ts");
const { Scheduler } = await import("../effect/ports/scheduler.ts");

// The bookmark lists are the app's own, cached per bookmarks tree: the shell compares them by identity, so the same
// lists must be the same lists.
const NO_BOOKMARKS = { bookmarkFolders: [], recentBookmarks: [], bookmarksBar: [], otherBookmarks: [] };

// The menu's state, as the app describes it. The shell only carries it to the Mac.
const menu = (s) => ({
  checked: s.settings.showFullUrl ? ["toggleFullUrl"] : [],
  disabled: [],
  titles: {},
  spaces: [],
  windows: [],
  ...NO_BOOKMARKS,
  recentlyClosed: [],
  warnBeforeQuitting: false,
});

// The Mac's listeners, and the calls the shell makes to it.
const listen = (lab, kind, listener) => {
  lab.listeners.push({ kind, listener });

  return () => {
    const at = lab.listeners.findIndex((l) => l.kind === kind);

    if (at >= 0) lab.listeners.splice(at, 1);
    lab.givenBack++;
  };
};

const failure = (name, message) => new ShellFailure({ operation: { name }, message, cause: new Error("the engine is busy") });

const fakeEngine = (lab) =>
  Layer.succeed(ShellEngine)({
    onCommand: (listener) => Effect.sync(() => listen(lab, "command", listener)),
    onWindowEvent: (listener) => Effect.sync(() => listen(lab, "window", listener)),
    onAppEvent: (listener) => Effect.sync(() => listen(lab, "app", listener)),
    onOpenURLs: (listener) => Effect.sync(() => listen(lab, "urls", listener)),
    onDownload: (listener) => Effect.sync(() => listen(lab, "download", listener)),
    windowIds: () =>
      lab.windowIdsFail ? Effect.fail(failure("shell.windowIds", "The windows the Mac has open could not be read.")) : Effect.succeed(lab.windowIds),
    isDarkAppearance: () => (lab.darkAnswer ? Effect.promise(() => lab.darkAnswer) : Effect.succeed(false)),
    setAppearance: (mode) =>
      Effect.sync(() => {
        lab.appearances.push(mode);
      }),
    openWindow: (id) =>
      Effect.gen(function* () {
        lab.opened.push(id);

        if (lab.heldOpen) yield* Effect.promise(() => lab.heldOpen);

        if (lab.failOpen.has(id)) yield* Effect.fail(failure("shell.openWindow", "The window could not be opened."));
      }),
    closeWindow: (id) =>
      Effect.sync(() => {
        lab.closed.push(id);
      }),
    focusWindow: (id) =>
      Effect.sync(() => {
        lab.focused.push(id);
      }),
    setWindowTitle: (id, title) =>
      Effect.sync(() => {
        lab.titles.set(id, title);
      }),
    setMenuState: (state, bookmarksChanged) =>
      lab.menuStateFail
        ? Effect.fail(failure("shell.setMenuState", "The menu's state could not be sent to the Mac."))
        : Effect.sync(() => void lab.menus.push({ state, bookmarksChanged })),
    releaseProfile: (profile) =>
      Effect.sync(() => {
        lab.released.push(profile);
      }),
  });

const fakeDiagnostics = (lab) =>
  Layer.succeed(Diagnostics)({
    report: (diagnostic) =>
      Effect.sync(() => {
        lab.reports.push(diagnostic);
      }),
    warn: () => Effect.void,
  });

// The Mac's answers take a turn to come back.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// The menu waits for the app to settle before it is built.
const afterMenu = () => new Promise((resolve) => setTimeout(resolve, 250));

const withShell = async (use) => {
  const lab = {
    appearances: [],
    closed: [],
    commands: [],
    events: [],
    failOpen: new Set(),
    focused: [],
    givenBack: 0,
    listeners: [],
    menus: [],
    opened: [],
    released: [],
    reports: [],
    titles: new Map(),
    urls: [],
    windowIds: [],
    windowIdsFail: false,
    menuStateFail: false,
  };

  const runtime = ManagedRuntime.make(
    ShellService.layer.pipe(
      Layer.provide(AuthorityStore.layer(useBrowser)),
      Layer.provide(fakeEngine(lab)),
      Layer.provide(Scheduler.layer),
      Layer.provide(fakeDiagnostics(lab)),
    ),
  );

  const service = await runtime.runPromise(ShellService);

  const handlers = {
    command: (event) => lab.commands.push(event.command),
    appEvent: (event) => lab.events.push(event.type),
    openURLs: (urls) => lab.urls.push(urls),
    menu: (s) => menu(s),
  };

  try {
    await use({ lab, runtime, service, handlers });
  } finally {
    await runtime.dispose();
  }
};

test("the shell registers one handler per event", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    await runtime.runPromise(service.start(handlers));

    for (const kind of ["command", "window", "app", "urls", "download"]) {
      const registered = lab.listeners.filter((l) => l.kind === kind);

      assert.equal(registered.length, 1, `one handler for the ${kind} event`);
    }

    assert.equal(lab.menus.length, 1, "the menu's state went to the Mac");
  });
});

test("a second start does not register the listeners again", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    await runtime.runPromise(service.start(handlers));
    await runtime.runPromise(service.start(handlers));

    for (const kind of ["command", "window", "app", "urls", "download"]) {
      const registered = lab.listeners.filter((l) => l.kind === kind);

      assert.equal(registered.length, 1, `one handler for the ${kind} event`);
    }

    assert.equal(lab.menus.length, 1, "the menu's state went to the Mac once");
  });
});

test("the teardown gives every registration back", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    await runtime.runPromise(service.start(handlers));

    assert.ok(lab.listeners.length > 0, "the listeners are registered");

    await runtime.dispose();

    assert.equal(lab.listeners.length, 0, "every listener is gone");
    assert.equal(lab.givenBack, 5, "each listener was given back once");
  });
});

test("a branch that fails is reported once, and the shell keeps working", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    lab.windowIdsFail = true;

    await runtime.runPromise(service.start(handlers));
    await settle();

    assert.equal(lab.reports.length, 1, "the failure is reported once");
    assert.equal(lab.reports[0].operation.name, "shell.windowIds");

    // The shell still answers the Mac's commands.
    const command = lab.listeners.find((l) => l.kind === "command");

    command.listener({ command: "newTab", arg: null, windowId: null });

    assert.deepEqual(lab.commands, ["newTab"], "the command reached the app");
  });
});

test("a native call that fails is reported once, and the shell stays usable", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    lab.menuStateFail = true;

    await runtime.runPromise(service.start(handlers));
    await afterMenu();

    assert.equal(lab.reports.length, 1, "the failure is reported once");
    assert.equal(lab.reports[0].operation.name, "shell.setMenuState");

    // The shell still answers the Mac's commands.
    const command = lab.listeners.find((l) => l.kind === "command");

    command.listener({ command: "newTab", arg: null, windowId: null });

    assert.deepEqual(lab.commands, ["newTab"], "the command reached the app");
  });
});

test("the menu's update is debounced, and the same state is sent only once", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    const { useBrowser } = await import("../store/browserStore.ts");

    await runtime.runPromise(service.start(handlers));
    await settle();

    assert.equal(lab.menus.length, 1, "the menu's state went to the Mac");

    // The store changes many times: the menu is built when the dust settles, not for every change.
    for (let i = 0; i < 5; i++) {
      useBrowser.setState((s) => ({ settings: { ...s.settings, showFullUrl: i % 2 === 0 } }));
    }

    assert.equal(lab.menus.length, 1, "the menu was not built for every change");

    await afterMenu();

    assert.equal(lab.menus.length, 2, "the menu was built once, after the changes settled");

    // The same state again: the Mac already has it.
    useBrowser.setState((s) => ({ settings: { ...s.settings, showFullUrl: true } }));
    await afterMenu();

    assert.equal(lab.menus.length, 2, "the same state is not sent twice");
  });
});

test("the windows the app opens and closes are reconciled with the Mac's answer", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    const { useBrowser } = await import("../store/browserStore.ts");

    // The app's own window, and one the Mac has that the app doesn't know.
    const id = useBrowser.getState().createWindow();

    lab.windowIds = [id, "ghost"];

    await runtime.runPromise(service.start(handlers));

    // The window the app has was opened on the Mac at once: the first frame waits for it.
    assert.ok(lab.opened.includes(id), "the window the app has was opened on the Mac");
    assert.ok(lab.titles.has(id), "the window was given its title");

    // The Mac's answer about which windows exist comes later.
    await settle();

    assert.deepEqual(lab.closed, ["ghost"], "the window the app doesn't have was closed");

    // The app closes the window: the Mac is told at once.
    useBrowser.getState().closeWindow(id);

    assert.ok(lab.closed.includes(id), "the window the app closed was closed on the Mac");
  });
});

test("the Mac's own window events reach the app", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    const { useBrowser } = await import("../store/browserStore.ts");

    const id = useBrowser.getState().createWindow();

    await runtime.runPromise(service.start(handlers));
    await settle();

    const window = lab.listeners.find((l) => l.kind === "window");

    window.listener({ type: "focus", id });

    assert.equal(useBrowser.getState().ui.focusedWindowId, id, "the window took the focus");

    window.listener({ type: "close", id });

    assert.equal(useBrowser.getState().windows[id], undefined, "the window closed in the app");
  });
});

test("the app's appearance reaches the Mac at once", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    const { useBrowser } = await import("../store/browserStore.ts");

    await runtime.runPromise(service.start(handlers));
    await settle();

    const before = lab.appearances.length;

    useBrowser.setState((s) => ({ settings: { ...s.settings, appearance: s.settings.appearance === "dark" ? "light" : "dark" } }));

    assert.equal(lab.appearances.length, before + 1, "the Mac was told without waiting");
  });
});

test("the shell's own changes stop when it is given back", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    const { useBrowser } = await import("../store/browserStore.ts");

    await runtime.runPromise(service.start(handlers));
    await settle();

    const before = lab.appearances.length;

    await runtime.dispose();

    // The app's appearance changes after the teardown: the Mac is not told any more.
    useBrowser.setState((s) => ({ settings: { ...s.settings, appearance: s.settings.appearance === "dark" ? "light" : "dark" } }));
    await settle();

    assert.equal(lab.appearances.length, before, "the Mac was not told");
  });
});

const deferred = () => {
  let resolve;

  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

test("a window the Mac could not open is taken out of the app, and reported once", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    const { useBrowser } = await import("../store/browserStore.ts");

    const id = useBrowser.getState().createWindow();

    lab.failOpen.add(id);

    await runtime.runPromise(service.start(handlers));
    await settle();

    assert.equal(useBrowser.getState().windows[id], undefined, "the window nothing shows is gone from the app");
    assert.deepEqual(
      lab.reports.map((r) => r.operation.name),
      ["shell.openWindow"],
      "the failure was reported once",
    );
    assert.equal(lab.opened.filter((opened) => opened === id).length, 1, "the window was not opened again");
    assert.ok(lab.closed.includes(id), "whatever the Mac made of it was closed");
  });
});

test("the shared host's shell opens windows for the states the coordinator accepts, and leaves the host's own be", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    const { useBrowser } = await import("../store/browserStore.ts");

    const first = useBrowser.getState().createWindow();

    // The host's own window (the coordinator's document) is one the app does not know.
    lab.windowIds = ["coordinator"];

    // The coordinator answers no menu command here: its windows run them.
    const withoutCommand = { ...handlers, command: undefined };

    await runtime.runPromise(service.start(withoutCommand, { shared: true }));
    await settle();

    assert.equal(lab.listeners.filter((l) => l.kind === "command").length, 0, "no command handler was registered");
    assert.ok(!lab.opened.includes(first), "a window waits for the coordinator to accept it");
    assert.ok(!lab.closed.includes("coordinator"), "the host's own window stays");

    const second = useBrowser.getState().createWindow();

    assert.ok(!lab.opened.includes(second), "a change to the store opens nothing by itself");

    // The coordinator accepts the state: the windows open, and it waits for the Mac's answer.
    const held = deferred();

    lab.heldOpen = held.promise;

    let reconciled = false;

    const reconciling = runtime.runPromise(service.reconcile(useBrowser.getState())).then(() => {
      reconciled = true;
    });

    await settle();

    assert.ok(lab.opened.includes(first) && lab.opened.includes(second), "the accepted windows were opened");
    assert.equal(reconciled, false, "the coordinator waits for the Mac to open them");

    held.resolve();
    await reconciling;

    assert.equal(reconciled, true, "the coordinator goes on once the Mac answered");

    lab.heldOpen = undefined;
    useBrowser.getState().closeWindow(first);
    useBrowser.getState().closeWindow(second);
  });
});

test("the appearance the Mac reports wins over its answer to the first question", async () => {
  await withShell(async ({ lab, runtime, service, handlers }) => {
    const { useBrowser } = await import("../store/browserStore.ts");
    const answer = deferred();

    lab.darkAnswer = answer.promise;

    await runtime.runPromise(service.start(handlers));

    // The Mac goes dark while the first question is still on its way.
    const app = lab.listeners.find((l) => l.kind === "app");

    app.listener({ type: "appearance", dark: true });

    assert.equal(useBrowser.getState().ui.appDark, true, "the app follows the Mac at once");
    assert.ok(lab.events.includes("appearance"), "the app still hears the event");

    // The answer to the first question comes back: it is older than the report.
    answer.resolve(false);
    await settle();

    assert.equal(useBrowser.getState().ui.appDark, true, "the older answer did not win");
  });
});
