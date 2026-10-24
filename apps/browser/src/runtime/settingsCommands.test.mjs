import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { DEFAULT_SETTINGS } from "../store/settings.ts";
import { executeSettingsCommand, parseSettingsCommand } from "./settingsCommands.ts";

const parsePatch = (patch) => parseSettingsCommand({ method: "updateSettings", patch }).patch;
const run = (store, command) => executeSettingsCommand(store, parseSettingsCommand(command));
const engine = { name: "Docs", keyword: "docs", url: "https://docs.example.com/search?q=%s" };

test("settings parser accepts every editable serialized default and preference form", () => {
  const editable = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  delete editable.customSearchEngines;
  delete editable.extensionSearchEngines;
  assert.deepEqual(parsePatch(editable), editable);
  const variants = {
    launchTab: ["newTab", "lastTab"],
    commandBarPreference: ["website", "search"],
    tabLayout: ["sidebar", "top"],
    newTabPosition: ["top", "bottom"],
    sidebarPosition: ["left", "right"],
    bookmarksBar: ["always", "newTab", "never"],
    appearance: ["auto", "light", "dark"],
    density: ["comfortable", "compact"],
    windowMaterial: ["solid", "glass"],
    addressBar: ["toolbar", "sidebar"],
    cleanUpInactiveTabsAfterHours: [null, 0, 12, 24],
    shortcuts: [{}, { newTab: ["t", "command"], disabled: [""] }],
    neverTranslateSites: [{}, { default: ["example.com"] }],
    awakeSites: [[], ["example.com"]],
    mutedSites: [[], ["example.com"]],
    developerSites: [[], ["localhost:3000"]],
    noAutoPictureInPictureSites: [[], ["example.com"]],
    littleBaySize: [
      [900, 640],
      [1, 1],
    ],
  };
  for (const [key, values] of Object.entries(variants)) {
    for (const value of values) assert.deepEqual(parsePatch({ [key]: value }), { [key]: value }, key);
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof value === "boolean") assert.deepEqual(parsePatch({ [key]: !value }), { [key]: !value });
  }
});

test("settings parser copies nested preferences and link destinations", () => {
  const patch = {
    shortcuts: { newTab: ["t", "command"] },
    neverTranslateSites: { default: ["example.com"] },
    awakeSites: ["example.com"],
    littleBaySize: [900, 640],
    externalLinkRules: [
      { id: "space", pattern: "example.com/*", sourceApp: "com.apple.mail", destination: { kind: "space", spaceId: "default", syncProfileId: "sync" } },
      { id: "little", pattern: "*.example.org", destination: { kind: "littleBay" } },
      { id: "window", pattern: "example.net", destination: { kind: "newWindow" } },
    ],
  };
  const parsed = parsePatch(patch);
  assert.deepEqual(parsed, patch);
  patch.shortcuts.newTab.push("shift");
  patch.neverTranslateSites.default.push("other.com");
  patch.awakeSites.push("other.com");
  patch.littleBaySize[0] = 1;
  patch.externalLinkRules[0].destination.spaceId = "other";
  assert.deepEqual(parsed.shortcuts.newTab, ["t", "command"]);
  assert.deepEqual(parsed.neverTranslateSites.default, ["example.com"]);
  assert.deepEqual(parsed.awakeSites, ["example.com"]);
  assert.deepEqual(parsed.littleBaySize, [900, 640]);
  assert.equal(parsed.externalLinkRules[0].destination.spaceId, "default");
});

test("settings parser rejects malformed patches and authority-owned engine arrays", () => {
  for (const patch of [
    null,
    [],
    Object.create({ appearance: "dark" }),
    { unknownSetting: true },
    { customSearchEngines: [] },
    { extensionSearchEngines: [] },
    { warnBeforeQuitting: "true" },
    { searchEngine: 1 },
    { customSearchUrl: null },
    { launchTab: "previous" },
    { appearance: "system" },
    { tabLayout: "vertical" },
    { sidebarPosition: "bottom" },
    { bookmarksBar: "sometimes" },
    { windowMaterial: "transparent" },
    { density: "large" },
    { addressBar: "floating" },
    { cleanUpInactiveTabsAfterHours: -1 },
    { cleanUpInactiveTabsAfterHours: "24" },
    { sidebarWidth: NaN },
    { sidebarWidth: Infinity },
    { sidebarWidth: null },
    { extensionSidePanelWidth: -2 },
    { littleBaySize: [0, 100] },
    { littleBaySize: [100, -1] },
    { littleBaySize: [100, Infinity] },
    { littleBaySize: [100] },
    { awakeSites: [1] },
    { mutedSites: "example.com" },
    { shortcuts: { newTab: "command+t" } },
    { shortcuts: { newTab: ["t", false] } },
    { neverTranslateSites: [] },
    { neverTranslateSites: { default: [null] } },
    { externalLinkRules: [{ id: "x", pattern: "example.com", destination: { kind: "space" } }] },
    { externalLinkRules: [{ id: "x", pattern: "bad host", destination: { kind: "newWindow" } }] },
    { externalLinkRules: [{ id: "x", pattern: "example.com", destination: { kind: "newWindow", windowId: "forged" } }] },
  ])
    assert.throws(() => parsePatch(patch), { code: "invalid_request" });
});

test("settings parser rejects sparse preference arrays instead of accepting missing elements", () => {
  const hole = Array(1);
  const trailingHole = Array(2);
  trailingHole[0] = "example.com";
  for (const key of ["awakeSites", "mutedSites", "developerSites", "noAutoPictureInPictureSites"]) {
    for (const value of [hole, trailingHole]) assert.throws(() => parsePatch({ [key]: value }), { code: "invalid_request" });
  }
  for (const key of ["shortcuts", "neverTranslateSites"]) {
    for (const value of [hole, trailingHole]) assert.throws(() => parsePatch({ [key]: { default: value } }), { code: "invalid_request" });
  }
  const missingHeight = Array(2);
  missingHeight[0] = 900;
  const missingWidth = Array(2);
  missingWidth[1] = 640;
  for (const value of [Array(2), missingHeight, missingWidth]) assert.throws(() => parsePatch({ littleBaySize: value }), { code: "invalid_request" });
});

test("settings command envelopes have closed fields and typed engine inputs", () => {
  const good = [
    { method: "updateSettings", patch: {} },
    { method: "setTabLayout", layout: "top" },
    { method: "setSearchEngine", id: "google" },
    { method: "removeCustomEngine", id: "custom" },
    { method: "addCustomEngine", input: engine },
    { method: "updateCustomEngine", id: "custom", input: engine },
  ];
  for (const command of good) {
    assert.deepEqual(parseSettingsCommand(command), command);
    assert.throws(() => parseSettingsCommand({ ...command, windowId: "forged" }), { code: "invalid_request" });
  }
  for (const command of [
    null,
    [],
    { method: "unknown" },
    { method: "setTabLayout", layout: "vertical" },
    { method: "setSearchEngine", id: " " },
    { method: "removeCustomEngine", id: 1 },
    { method: "addCustomEngine", input: { ...engine, id: "forged" } },
    { method: "addCustomEngine", input: { ...engine, url: null } },
    { method: "updateCustomEngine", id: "custom", input: { name: "Missing fields" } },
  ])
    assert.throws(() => parseSettingsCommand(command), { code: "invalid_request" });
});

test("custom engine commands report domain validation errors without mutating the store", () => {
  const store = createBrowserStore();
  const invalid = [
    [{ ...engine, name: "" }, "Enter a name."],
    [{ ...engine, keyword: "" }, "Enter a shortcut."],
    [{ ...engine, keyword: "two words" }, "The shortcut can't contain spaces."],
    [{ ...engine, url: "file:///tmp/%s" }, "Enter a URL that starts with http:// or https://."],
    [{ ...engine, url: "https://example.com/" }, "The URL must contain %s where the search terms go."],
  ];
  for (const [input, message] of invalid) {
    const before = store.getState();
    assert.throws(() => run(store, { method: "addCustomEngine", input }), { code: "invalid_request", message });
    assert.equal(store.getState(), before);
  }
  const id = run(store, { method: "addCustomEngine", input: engine });
  assert.equal(typeof id, "string");
  assert.deepEqual(store.getState().settings.customSearchEngines, [{ id, ...engine }]);
  const before = store.getState();
  assert.throws(() => run(store, { method: "addCustomEngine", input: engine }), { code: "invalid_request", message: /already used/ });
  assert.throws(() => run(store, { method: "updateCustomEngine", id: "missing", input: engine }), {
    code: "invalid_request",
    message: "This search engine no longer exists.",
  });
  assert.throws(() => run(store, { method: "updateCustomEngine", id, input: { ...engine, name: "" } }), { code: "invalid_request", message: "Enter a name." });
  assert.equal(store.getState(), before);
  assert.equal(run(store, { method: "updateCustomEngine", id, input: { ...engine, name: "Updated" } }), null);
  assert.equal(store.getState().settings.customSearchEngines[0].name, "Updated");
  run(store, { method: "setSearchEngine", id });
  assert.equal(store.getState().settings.searchEngine, id);
  run(store, { method: "removeCustomEngine", id });
  assert.deepEqual(store.getState().settings.customSearchEngines, []);
  assert.equal(store.getState().settings.searchEngine, DEFAULT_SETTINGS.searchEngine);
});

test("settings commands reject missing spaces and search engines before mutation", () => {
  const store = createBrowserStore();
  for (const command of [
    { method: "updateSettings", patch: { defaultSpaceId: "missing" } },
    { method: "updateSettings", patch: { searchEngine: "missing" } },
    { method: "setSearchEngine", id: "missing" },
  ]) {
    const before = store.getState();
    assert.throws(() => run(store, command), { code: "invalid_request" });
    assert.equal(store.getState(), before);
  }
  const spaceId = store.getState().createSpace({ name: "Work" });
  run(store, { method: "updateSettings", patch: { defaultSpaceId: spaceId, searchEngine: "google", cleanUpInactiveTabsAfterHours: null } });
  assert.equal(store.getState().settings.defaultSpaceId, spaceId);
  assert.equal(store.getState().settings.cleanUpInactiveTabsAfterHours, null);
});

test("settings default space validation rejects inherited object properties without mutation", () => {
  const store = createBrowserStore();
  for (const defaultSpaceId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(Object.hasOwn(store.getState().spaces, defaultSpaceId), false);
    const before = store.getState();
    assert.throws(() => run(store, { method: "updateSettings", patch: { defaultSpaceId, appearance: "dark" } }), {
      code: "invalid_request",
      message: "Space no longer exists",
    });
    assert.equal(store.getState(), before);
  }
});

test("setting global tab layout updates defaults and all window overrides in one commit", () => {
  const store = createBrowserStore();
  const first = store.getState().createWindow({ url: "first.example.com" });
  const second = store.getState().createWindow({ url: "second.example.com" });
  const small = store.getState().createWindow({ small: true, url: "small.example.com" });
  const privateWindow = store.getState().createWindow({ incognito: true });
  store.setState({ windows: { ...store.getState().windows, [first]: { ...store.getState().windows[first], tabLayout: "top" } } });
  const before = store.getState();
  const snapshots = [];
  const unsubscribe = store.subscribe((state) => snapshots.push(state));
  assert.equal(run(store, { method: "setTabLayout", layout: "top" }), null);
  unsubscribe();
  assert.equal(snapshots.length, 1);
  const after = snapshots[0];
  assert.equal(after.settings.tabLayout, "top");
  for (const id of [first, second, small, privateWindow]) assert.deepEqual(after.windows[id], { ...before.windows[id], tabLayout: "top" });
  assert.equal(after.tabs, before.tabs);
  assert.equal(after.windowUi, before.windowUi);
  assert.equal(after.windowOrder, before.windowOrder);
  run(store, { method: "setTabLayout", layout: "sidebar" });
  assert.equal(store.getState().settings.tabLayout, "sidebar");
  assert.ok(Object.values(store.getState().windows).every((window) => window.tabLayout === "sidebar"));
});
