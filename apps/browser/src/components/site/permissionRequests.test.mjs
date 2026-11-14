import assert from "node:assert/strict";
import { test } from "node:test";
import "../../test-loader.mjs";

const { onPermission, onPermissionDismissed, permissionEvents } = await import("../../test-native-stub.mjs");
const { startPermissionRequests } = await import("./permissionRequests.ts");
const { patchPage, pageOf, usePages } = await import("../window/pageState.ts");

const request = (id, browserId) => ({ id, browserId, origin: "https://a.test/", permissions: ["camera"] });
const browsers = (entries) => usePages.setState((s) => ({ browsers: { ...s.browsers, ...entries } }));

startPermissionRequests();

assert.ok(onPermission && onPermissionDismissed);

test("a window showing the tab asks; a window that never showed it holds the request until it does", () => {
  browsers({ 1: "shown" });
  patchPage("shown", {});
  permissionEvents.fire("onPermission", request("p1", 1));
  assert.equal(pageOf("shown").permission?.id, "p1");

  permissionEvents.fire("onPermission", request("p2", 2));
  assert.equal(pageOf("later").permission ?? null, null);
  browsers({ 2: "later" });
  assert.equal(pageOf("later").permission?.id, "p2");
});

// The web host tells every window that a prompt went: one held here must not surface when its tab arrives.
test("a request answered elsewhere never comes up when its tab arrives later", () => {
  permissionEvents.fire("onPermission", request("p3", 3));
  permissionEvents.fire("onPermissionDismissed", { id: "p3" });
  browsers({ 3: "moved" });
  assert.equal(pageOf("moved").permission ?? null, null);
});
