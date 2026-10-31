import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import { SETTINGS } from "./definitions.ts";
import * as constants from "./constants.ts";
import { findSettings } from "./search.ts";
import { useSettingsNav } from "./windows.ts";

// Render the pane's element tree with native controls represented by their names.
// Its store selectors still read the supplied state; child components need no native runtime.
const require = createRequire(import.meta.url);
const tabsCode = ts.transpileModule(readFileSync(new URL("./panes/Tabs.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

function renderTabs(tabLayout) {
  const patches = [];
  const state = { settings: { tabLayout, newTabPosition: "top" }, updateSettings: (patch) => patches.push(patch) };
  const controls = Object.fromEntries(
    ["Button", "Checkbox", "Group", "PopUp", "Row", "SectionHeader", "SettingToggle", "TextField", "Toggle"].map((name) => [name, name]),
  );
  const mocks = {
    "@bay/shell": { Symbol: "Symbol" },
    "@bay/platform": { View: "View", Pressable: "Pressable", capabilities: { calendar: true } },
    "../../../runtime/commands": { reportBrowserCommand: () => {} },
    "../../../runtime/settingsActions": { updateSettings: (patch) => state.updateSettings(patch) },
    "../../../runtime/splitActions": { toggleTabLayout: () => {} },
    "../../../store/read": { useBrowserRead: (selector) => selector(state), browserRead: { getState: () => state } },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable" },
    "../../../lib/theme": {},
    "../../../store/browser": { useBrowser: (selector) => selector(state) },
    "../controls": controls,
    "../definitions": { SETTINGS },
    "../constants": constants,
    "../../../live/store": {},
    "../../../lib/awakeSites": {},
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", tabsCode)((id) => mocks[id] ?? require(id), module, module.exports);
  return { tree: module.exports.TabsPane(), patches };
}

function findTarget(element, id) {
  if (!element || typeof element !== "object") return undefined;
  if (element.props?.settingId === id) return element;
  for (const child of [element.props?.children].flat()) {
    const target = findTarget(child, id);
    if (target) return target;
  }
}

for (const layout of ["sidebar", "top"]) {
  test(`search targets the tab-position row with ${layout} tabs regardless of its label`, () => {
    const entry = findSettings("add new tabs")[0];
    assert.equal(entry.id, SETTINGS.newTabPosition.id);
    useSettingsNav.getState().go(entry.pane, null, entry.id);
    const { tree, patches } = renderTabs(layout);
    const row = findTarget(tree, useSettingsNav.getState().highlight);
    assert.ok(row, "the search target identifies the rendered row");
    assert.equal(row.props.title, layout === "top" ? "Add new tabs to the left" : "Add new tabs to the top");
    row.props.children.props.onChange(false);
    assert.deepEqual(patches, [{ newTabPosition: "bottom" }]);
  });
}

test("search accepts the horizontal tab-position wording", () => {
  assert.equal(findSettings("new tabs left")[0]?.id, SETTINGS.newTabPosition.id);
});

test("search IDs are unique and pane navigation clears a previous target", () => {
  const ids = Object.values(SETTINGS).map((setting) => setting.id);
  assert.equal(new Set(ids).size, ids.length);
  const nav = useSettingsNav.getState();
  nav.go("general");
  nav.go("tabs", null, SETTINGS.newTabPosition.id);
  nav.goBack();
  assert.equal(useSettingsNav.getState().pane, "general");
  assert.equal(useSettingsNav.getState().highlight, null);
  nav.goForward();
  assert.equal(useSettingsNav.getState().pane, "tabs");
  assert.equal(useSettingsNav.getState().highlight, null);
  nav.go("tabs", null, SETTINGS.tabLayout.id);
  assert.equal(useSettingsNav.getState().highlight, SETTINGS.tabLayout.id);
  nav.go("tabs");
  assert.equal(useSettingsNav.getState().highlight, null);
});
