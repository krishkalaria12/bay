import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native-stub.mjs");
const { useBrowser } = await import("../../store/browser.ts");
const { usePages } = await import("../layout/pageState.ts");
const { extensionProfile, pageProfile, shownIn, useExtensions, windowExtensions } = await import("./store.ts");
const { closeSidePanel, openSidePanel } = await import("./sidePanels.ts");

const extension = (id, options = {}) => ({ id, enabled: true, incognito: false, sidePanel: "panel.html", ...options });

function setup(list) {
  useBrowser.getState().hydrate({});
  const normal = useBrowser.getState().createWindow({ url: "https://normal.example" });
  const privateWindow = useBrowser.getState().createWindow({ incognito: true, url: "https://private.example" });
  const window = useBrowser.getState().windows[privateWindow];
  const tab = window.activeTabIds[window.spaceId];
  usePages.setState({ browsers: { 1: tab } });
  useExtensions.setState({ lists: { "": list }, actions: {}, popup: null, sidePanels: {} });
  return { normal, privateWindow };
}

test("private toolbar and menus show allowed split and spanning extensions only", () => {
  const { normal, privateWindow } = setup([
    extension("off"),
    extension("spanning", { incognito: true }),
    extension("split", { incognito: true, incognitoSplit: true }),
    extension("disabled", { incognito: true, enabled: false }),
  ]);
  const s = useBrowser.getState();
  assert.equal(extensionProfile(s, privateWindow), "");
  assert.match(pageProfile(s, privateWindow), /^incognito/);
  assert.deepEqual(
    windowExtensions(s, normal).map((x) => x.id),
    ["off", "spanning", "split"],
  );
  assert.deepEqual(
    windowExtensions(s, privateWindow).map((x) => x.id),
    ["spanning", "split"],
  );
  assert.equal(shownIn(privateWindow, "off"), undefined);
  useExtensions.setState({ lists: { "": [extension("spanning", { incognito: false })] } });
  assert.equal(shownIn(privateWindow, "spanning"), undefined, "revoking permission immediately removes the action");
});

test("a permitted spanning extension can open its panel in a private window", async () => {
  const { privateWindow } = setup([extension("spanning", { incognito: true })]);
  native.extensionAnswers.sidePanelUrl = async () => "chrome-extension://spanning/panel.html";
  await openSidePanel(privateWindow, "spanning");
  assert.equal(useExtensions.getState().sidePanels[privateWindow]?.extensionId, "spanning");
  assert.match(useExtensions.getState().sidePanels[privateWindow].pageProfile, /^incognito/);
  closeSidePanel(privateWindow);
});

test("a panel response arriving after private access is revoked stays closed", async () => {
  const { privateWindow } = setup([extension("spanning", { incognito: true })]);
  let answer;
  native.extensionAnswers.sidePanelUrl = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const opening = openSidePanel(privateWindow, "spanning");
  useExtensions.setState({ lists: { "": [extension("spanning")] } });
  answer("chrome-extension://spanning/panel.html");
  await opening;
  assert.equal(useExtensions.getState().sidePanels[privateWindow], undefined);
});
