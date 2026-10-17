import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BAY_TEST_PLATFORM = "windows";
const { useBrowser } = await import("../../store/browser.ts");
const { clickTab } = await import("./actions.ts");
const { activeTabId } = await import("../../store/model.ts");

function tabs() {
  useBrowser.getState().hydrate({});
  const windowId = useBrowser.getState().createWindow();
  const first = useBrowser.getState().windows[windowId].tabIds[0];
  const second = useBrowser.getState().newTab(windowId, { url: "https://second.example", background: true });
  const third = useBrowser.getState().newTab(windowId, { url: "https://third.example", background: true });
  clickTab(windowId, first);
  return { windowId, first, second, third };
}

test("Windows Ctrl-click toggles tab selection without activating the clicked tab", () => {
  const { windowId, first, second, third } = tabs();
  clickTab(windowId, second, { ctrlKey: true });
  assert.deepEqual(useBrowser.getState().selection[windowId], [first, second]);
  clickTab(windowId, third, { ctrlKey: true });
  assert.deepEqual(useBrowser.getState().selection[windowId], [first, second, third]);
  clickTab(windowId, second, { ctrlKey: true });
  assert.deepEqual(useBrowser.getState().selection[windowId], [first, third]);
});

test("Windows Meta-click activates normally and Shift-click still selects a range", () => {
  const { windowId, first, second, third } = tabs();
  clickTab(windowId, second, { metaKey: true });
  assert.deepEqual(useBrowser.getState().selection[windowId] ?? [], []);
  assert.equal(activeTabId(useBrowser.getState(), windowId), second);
  clickTab(windowId, first);
  clickTab(windowId, third, { shiftKey: true });
  assert.deepEqual(useBrowser.getState().selection[windowId], [first, second, third]);
});
