import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

if (!process.env.BAY_MENU_TEST_CHILD) {
  for (const platform of ["windows", "macos"]) {
    test(`${platform} command and app menus use existing desktop handlers`, () => {
      const env = { ...process.env, BAY_MENU_TEST_CHILD: "1", BAY_TEST_PLATFORM: platform };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(
        process.execPath,
        ["--no-warnings", "--import", "./src/test-loader.mjs", "--test", "src/components/omnibox/menuActions.test.mjs"],
        {
          cwd: new URL("../../../", import.meta.url),
          env,
          encoding: "utf8",
        },
      );
      assert.match(output, /tests 3/, "the platform child must actually run its menu assertions");
    });
  }
} else {
  const calls = [];
  const info = { appName: "Bay", appVersion: "1.0", appBuild: "42", osVersion: "11", updates: false };
  globalThis.nnMenuTest = { calls, info, isDefault: false, defaultBrowser: true };
  const stub = `
    const fixture=globalThis.nnMenuTest;
    export const runCommand=event=>fixture.calls.push(event);
    export const sendFeedback=id=>fixture.calls.push(['feedback',id]);
    export const releaseNotesUrl=()=>null;
    export const openReleaseNotesPage=id=>fixture.calls.push(['notes',id]);
    export const startOnboarding=id=>fixture.calls.push(['setup',id]);
    export const openSettings=pane=>fixture.calls.push(['settings',pane]);
    export const systemInfo=()=>fixture.info;
    export const confirm=options=>fixture.calls.push(['confirm',options]);
    export const checkForUpdates=()=>fixture.calls.push(['updates']);
    export const setAsDefaultBrowser=async()=>fixture.defaultBrowser;
    export const isDefaultBrowser=async()=>fixture.isDefault;
    export const isInternalTab=tab=>!!tab&&String(tab.navigation?.url??tab.url).toLowerCase().startsWith("bay://");
  `;
  const stubUrl = `data:text/javascript,${encodeURIComponent(stub)}`;
  registerHooks({
    resolve(specifier, context, next) {
      if (
        context.parentURL?.includes("/components/omnibox/") &&
        ["../../lib/commands", "../../lib/appIntegration", "../../lib/releaseNotesPage", "../onboarding", "../settings/windows", "../pages/urls"].includes(
          specifier,
        )
      )
        return { url: stubUrl, shortCircuit: true };
      if (specifier === "@bay/shell" && context.parentURL?.includes("/omnibox/paletteAppActions.ts")) return { url: stubUrl, shortCircuit: true };
      return next(specifier, context);
    },
  });
  const { createBrowserStore } = await import("../../store/browser.ts");
  const { barActions, runBarAction } = await import("./actions.ts");
  const { activeTabId } = await import("../../store/model.ts");
  const { appPaletteActions } = await import("./paletteAppActions.ts");
  const { isMac } = await import("@bay/platform");
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "https://example.com/" });
  const tabId = activeTabId(store.getState(), windowId);
  const ids = (id = windowId) => barActions(store.getState(), id).map((action) => action.id);

  test("Settings shortcut and asynchronous app menu dismissal follow the platform", async () => {
    let dismissed = 0;
    const settings = (
      await appPaletteActions(windowId, () => {
        dismissed++;
      })
    ).find((action) => action.id === "settings");
    assert.equal(settings.hint, isMac ? "⌘," : "Ctrl+,");
    await settings.run();
    assert.deepEqual(calls.at(-1), ["settings", undefined]);
    assert.equal(dismissed, 1);
    globalThis.nnMenuTest.isDefault = true;
    assert.equal(
      (await appPaletteActions(windowId, () => {})).some((action) => action.id === "default-browser"),
      false,
    );
    globalThis.nnMenuTest.isDefault = false;
    globalThis.nnMenuTest.defaultBrowser = false;
    const makeDefault = (
      await appPaletteActions(windowId, () => {
        dismissed++;
      })
    ).find((action) => action.id === "default-browser");
    await assert.rejects(makeDefault.run(), /wasn't changed/);
    assert.equal(dismissed, 1, "failed actions leave the app menu open");
  });

  test("desktop commands are discoverable only without the native menu", () => {
    const desktop = [
      "openFile",
      "newLittleBay",
      "toggleOpenLinksInLittleBay",
      "savePage",
      "printWithSystemDialog",
      "findNext",
      "findPrevious",
      "viewSource",
      "openSplitPane",
      "toggleTabLayout",
      "bookmarkAllTabs",
      "manageExtensions",
      "addExtension",
      "cast",
    ];
    for (const command of desktop) assert.equal(ids().includes(command), !isMac, command);
    assert.equal(ids().includes("share"), isMac, "Windows has no native share handler yet");
    if (!isMac) {
      const actions = barActions(store.getState(), windowId);
      assert.equal(actions.find((action) => action.id === "openFile").hint, "Ctrl+O");
      assert.equal(actions.find((action) => action.id === "openFile").title, "Open File…");
      assert.equal(actions.find((action) => action.id === "savePage").hint, "Ctrl+S");
      assert.equal(actions.find((action) => action.id === "viewSource").hint, "Ctrl+U");
      for (const action of actions) assert.ok(!/[⌃⌥⇧⌘]/.test(action.hint ?? ""), action.id);
      const handlers =
        readFileSync(new URL("../../lib/commands.ts", import.meta.url), "utf8") + readFileSync(new URL("../sidebar/commands.ts", import.meta.url), "utf8");
      for (const command of desktop) assert.ok(handlers.includes(`case "${command}"`), `${command} has a real command handler`);
      calls.length = 0;
      for (const command of desktop) runBarAction(command, windowId);
      assert.deepEqual(
        calls.map((call) => [call.command, call.arg, call.windowId]),
        desktop.map((command) => [command, null, windowId]),
      );
    }
  });

  test("blank/internal pages and Little Bay hide commands without an applicable page or tab layout", () => {
    if (isMac) return;
    store.getState().updateTab(tabId, { url: "", navigation: null });
    for (const id of ["savePage", "viewSource", "printWithSystemDialog", "cast", "findNext"]) assert.ok(!ids().includes(id), id);
    assert.ok(ids().includes("openFile"));
    store.getState().updateTab(tabId, { url: "bay://history", navigation: null });
    for (const id of ["savePage", "printWithSystemDialog", "cast", "findNext"]) assert.ok(!ids().includes(id), id);
    const littleBay = store.getState().createWindow({ small: true, url: "https://little-bay.example/" });
    const openInMain = barActions(store.getState(), littleBay).find((action) => action.id === "openFile");
    assert.equal(openInMain.title, "Open in Main Window");
    runBarAction(openInMain.id, littleBay);
    assert.deepEqual(calls.at(-1), { command: "openFile", arg: null, windowId: littleBay });
    // The existing Little Bay command intentionally moves its page instead of
    // opening a picker. Keep the palette label aligned with that handler.
    const commandSource = readFileSync(new URL("../../lib/commands.ts", import.meta.url), "utf8");
    const littleBayHandler = commandSource.slice(commandSource.indexOf("function runLittleBayCommand"));
    assert.match(littleBayHandler, /case "openFile":\s*reportBrowserCommand\(openInMainWindow\(windowId\)\);/);
    for (const id of ["toggleTabLayout", "openSplitPane", "nextTab", "bookmarkAllTabs"]) assert.ok(!ids(littleBay).includes(id), id);
  });
}
