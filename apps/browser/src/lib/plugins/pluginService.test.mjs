import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  decideLink,
  deletePlugin,
  pluginSourceItems,
  pluginsRunning,
  reloadPlugins,
  runPluginCommand,
  setPluginEnabled,
  setPluginSecret,
  setPluginSetting,
  startPlugins,
} from "./pluginService.ts";
import { usePlugins, EMPTY_PLUGINS } from "./pluginStore.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const manifest = (id, extra = {}) => ({
  id,
  name: id,
  version: "1",
  description: "",
  main: "main.js",
  permissions: { hosts: ["https://api.example.com"], tabs: false, links: false, ...extra.permissions },
  settings: extra.settings ?? [],
  contributes: {
    commands: [{ id: "go", title: "Go", icon: "star", keywords: [], page: false }],
    toolbar: [{ id: "b", title: "B", icon: "star", command: "go" }],
    tabMenu: [],
    sidebarViews: [],
    liveSources: [{ id: "items", name: "Items", kind: "documents" }],
    themes: [],
  },
});

// A plugin's side of its sandbox: answers runs with `handlers`, and makes the calls a handler asks for.
function fakeHost({ plugins, handlers = {}, documents = {} }) {
  const calls = [];
  const sandboxes = new Map();
  const keychain = new Map();
  const opened = [];

  const host = {
    calls,
    opened,
    keychain,
    documents,
    sandboxes,
    list: async () => ({ plugins, problems: [] }),
    remove: async () => true,
    sandbox(id, events) {
      let next = 0;
      const replies = new Map();

      const call = (m, ...a) =>
        new Promise((resolve, reject) => {
          const n = ++next;
          replies.set(n, { resolve, reject });
          events.message(JSON.stringify({ t: "call", n, m, a }));
        });

      const box = {
        stopped: false,
        post(text) {
          const message = JSON.parse(text);

          if (message.t === "reply") {
            const reply = replies.get(message.n);
            replies.delete(message.n);

            if (message.ok) reply.resolve(message.v);
            else reply.reject(new Error(message.e));
          } else if (message.t === "run") {
            const handler = handlers[`${id}:${message.k}:${message.id}`];

            void Promise.resolve(handler ? handler(message.a, call) : Promise.reject(new Error("no handler"))).then(
              (v) => events.message(JSON.stringify({ t: "done", n: message.n, ok: true, v: v ?? null })),
              (e) => events.message(JSON.stringify({ t: "done", n: message.n, ok: false, e: e.message })),
            );
          }
        },
        stop() {
          box.stopped = true;
        },
      };

      sandboxes.set(id, box);
      setTimeout(() => events.message('{"t":"ready"}'), 0);

      return box;
    },
    async fetch(url, init) {
      calls.push(["fetch", url, init.method]);

      return { status: 200, url, headers: { "content-type": "text/plain" }, body: "hello" };
    },
    async openTab(url) {
      opened.push(url);
    },
    activeTab: () => ({ url: "https://page.example/", title: "Page" }),
    notify() {},
    refreshLive: (source) => calls.push(["refresh", source]),
    readDocument: (name) => documents[name] ?? null,
    writeDocument: (name, text) => {
      documents[name] = text;
    },
    keychainGet: async (account) => keychain.get(account) ?? null,
    keychainSet: async (account, value) => void keychain.set(account, value),
    keychainDelete: async (account) => void keychain.delete(account),
    now: () => Date.now(),
  };

  return host;
}

let stop = () => {};

afterEach(() => {
  stop();
  usePlugins.setState(EMPTY_PLUGINS, true);
});

test("plugins come in off, and run once turned on", async () => {
  const host = fakeHost({ plugins: [manifest("hello")] });
  stop = startPlugins(host);
  await tick();

  assert.equal(usePlugins.getState().plugins[0].enabled, false);
  assert.deepEqual(pluginsRunning(), []);

  await setPluginEnabled("hello", true);
  await tick();
  assert.deepEqual(pluginsRunning(), ["hello"]);
  assert.equal(usePlugins.getState().plugins[0].status, "running");
  assert.equal(JSON.parse(host.documents["plugins.json"]).enabled.hello, true);

  await setPluginEnabled("hello", false);
  assert.deepEqual(pluginsRunning(), []);
  assert.ok(host.sandboxes.get("hello").stopped);
});

test("a command's calls are checked against the manifest", async () => {
  const results = {};

  const host = fakeHost({
    plugins: [manifest("hello")],
    documents: { "plugins.json": JSON.stringify({ enabled: { hello: true } }) },
    handlers: {
      "hello:command:go": async (args, call) => {
        results.args = args;
        results.allowed = await call("fetch", "https://api.example.com/x", { method: "GET", headers: {}, body: null });
        results.refused = await call("fetch", "https://evil.example/", { method: "GET", headers: {}, body: null }).catch((e) => e.message);
        await call("toolbar.set", "b", { badge: "3" });
        await call("tabs.open", "https://a.example/", {});
      },
    },
  });

  stop = startPlugins(host);
  await tick();
  await tick();

  await runPluginCommand("hello", "go", { source: "toolbar", tab: { url: "https://secret.example/", title: "Secret" } });
  // Without permissions.tabs the page isn't the plugin's to see.
  assert.deepEqual(results.args, { source: "toolbar", tab: null });
  assert.equal(results.allowed.body, "hello");
  assert.match(results.refused, /permissions\.hosts/);
  assert.deepEqual(usePlugins.getState().toolbar["hello/b"], { badge: "3" });
  assert.deepEqual(host.opened, ["https://a.example/"]);
});

test("a tab opens only while something the person chose runs", async () => {
  let opener;

  const host = fakeHost({
    plugins: [manifest("hello")],
    documents: { "plugins.json": JSON.stringify({ enabled: { hello: true } }) },
    handlers: {
      "hello:source:items": async (_args, call) => {
        opener = await call("tabs.open", "https://a.example/", {}).catch((e) => e.message);

        return [{ id: "1", url: "https://a.example/1", title: "One" }];
      },
    },
  });

  stop = startPlugins(host);
  await tick();

  const items = await pluginSourceItems("hello", "items");
  assert.deepEqual(items, [{ id: "1", url: "https://a.example/1", title: "One" }]);
  assert.match(opener, /only while a command/);
  assert.deepEqual(host.opened, []);
});

test("settings and secrets reach the plugin, and go when it's deleted", async () => {
  let seen;

  const settings = [
    { key: "team", title: "Team", type: "text", default: "", options: [] },
    { key: "token", title: "Token", type: "secret", default: null, options: [] },
  ];

  const host = fakeHost({
    plugins: [manifest("hello", { settings })],
    documents: { "plugins.json": JSON.stringify({ enabled: { hello: true } }) },
    handlers: { "hello:command:go": async (_a, call) => void (seen = await call("settings.get")) },
  });

  stop = startPlugins(host);
  await tick();

  await setPluginSetting("hello", "team", "core");
  await setPluginSecret("hello", "token", "s3cret");
  await assert.rejects(setPluginSetting("hello", "team", 5));
  await runPluginCommand("hello", "go", { source: "commandBar", tab: null });

  assert.deepEqual(seen, { team: "core", token: "s3cret" });
  assert.deepEqual(usePlugins.getState().secrets, { hello: ["token"] });
  assert.ok(!host.documents["plugins.json"].includes("s3cret"), "secrets stay in the keychain");

  await deletePlugin("hello");
  assert.equal(host.keychain.size, 0);
  assert.deepEqual(JSON.parse(host.documents["plugins.json"]).settings, {});
});

test("the first plugin to decide a link wins, and a slow one is passed over", async () => {
  const host = fakeHost({
    plugins: [manifest("slow", { permissions: { links: true } }), manifest("quick", { permissions: { links: true } }), manifest("quiet")],
    documents: { "plugins.json": JSON.stringify({ enabled: { slow: true, quick: true, quiet: true } }) },
    handlers: {
      "slow:links:links": () => new Promise((resolve) => setTimeout(() => resolve({ space: "Late" }), 1000)),
      "quick:links:links": async (link) => (link.url.includes("work") ? { space: "Work" } : null),
    },
  });

  stop = startPlugins(host);
  await tick();
  await tick();

  assert.deepEqual(await decideLink({ url: "https://work.example/", sourceApp: null, spaces: [] }), { kind: "space", space: "Work" });
  assert.equal(await decideLink({ url: "https://home.example/", sourceApp: null, spaces: [] }), null);
});

test("a plugin that's removed from the folder stops", async () => {
  const plugins = [manifest("hello")];
  const host = fakeHost({ plugins, documents: { "plugins.json": JSON.stringify({ enabled: { hello: true } }) } });
  stop = startPlugins(host);
  await tick();
  assert.deepEqual(pluginsRunning(), ["hello"]);

  plugins.length = 0;
  await reloadPlugins();
  assert.deepEqual(pluginsRunning(), []);
  assert.deepEqual(usePlugins.getState().plugins, []);
});
