import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useBrowser } from "../../store/browser.ts";
import { SYNCED_SETTINGS } from "../../sync/adapters.ts";
import { activeTabId } from "../../store/model.ts";
import { clearChromeTabId, patchPage, setBrowserId, usePages } from "../layout/pageState.ts";
import { shownCliTab, startCliControl, useCli } from "./control.ts";
import * as stub from "../../test-native-stub.mjs";

const S = () => useBrowser.getState();
beforeEach(() => {
  S().hydrate({});
  usePages.setState({ pages: {}, browsers: {}, chromeTabs: {} });
});

function page() {
  const window = S().createWindow({ url: "https://example.com" });
  S().setFocusedWindow(window);
  const id = activeTabId(S(), window);
  setBrowserId(id, 4, 81);
  return { window, id };
}

test("terminal control defaults off and is never synced to another Mac", () => {
  assert.equal(S().settings.cliControl, false);
  assert.ok(!SYNCED_SETTINGS.includes("cliControl"));
});

test("active terminal target is Chrome's tab id, not the native view's id", () => {
  page();
  assert.equal(shownCliTab(S()), 81);
});

test("an unready page, New Tab surface, sleeping page, or WebKit page has no terminal target", () => {
  const { id } = page();
  setBrowserId(id, 4);
  assert.equal(shownCliTab(S()), null);
  setBrowserId(id, 4, 81);
  patchPage(id, { newTabShown: { url: "https://example.com", title: "Example", favicon: null } });
  assert.equal(shownCliTab(S()), null);
  patchPage(id, { newTabShown: null });
  clearChromeTabId(id);
  assert.equal(shownCliTab(S()), null);
  setBrowserId(id, 4, 81);
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], engine: "webkit" } } }));
  assert.equal(shownCliTab(S()), null);
});

test("the active pane of a split and a Peek over it supply the terminal target", () => {
  const { window, id } = page();
  const second = S().newTab(window, { url: "https://second.example" });
  setBrowserId(second, 5, 82);
  S().createSplit([id, second]);
  S().activate(second, window);
  assert.equal(shownCliTab(S()), 82);
  const peek = S().openPeek(second, "https://peek.example");
  setBrowserId(peek, 6, 83);
  assert.equal(shownCliTab(S()), 83);
  S().closePeek(window);
  assert.equal(shownCliTab(S()), 82);
});

test("closing a tab clears its Chrome identity", () => {
  const { id } = page();
  S().closeTabs([id]);
  assert.equal(usePages.getState().chromeTabs[id], undefined);
  assert.equal(shownCliTab(S()), null);
});

test("newer control requests win and policy revocation switches the setting off", async () => {
  page();
  const pending = [];
  stub.cliControlAnswers.call = (on) =>
    on === undefined ? Promise.resolve({ state: "off", generation: 0 }) : new Promise((resolve) => pending.push({ on, resolve }));
  startCliControl();
  await Promise.resolve();
  S().updateSettings({ cliControl: true });
  S().updateSettings({ cliControl: false });
  assert.deepEqual(
    pending.map((call) => call.on),
    [true, false],
  );
  pending[1].resolve({ state: "off", generation: 2 });
  await Promise.resolve();
  pending[0].resolve({ state: "on", generation: 1 });
  await Promise.resolve();
  assert.equal(useCli.getState().server.state, "off");
  S().updateSettings({ cliControl: true });
  pending[2].resolve({ state: "on", generation: 3 });
  await Promise.resolve();
  assert.equal(stub.cliActiveCalls.at(-1), 81);
  stub.emitCliControl({ state: "off", generation: 4, reason: "Disabled by policy" });
  assert.equal(S().settings.cliControl, false);
  assert.equal(useCli.getState().server.reason, "Disabled by policy");
  pending[3].resolve({ state: "off", generation: 4, reason: "Disabled by policy" });
  await Promise.resolve();
});
