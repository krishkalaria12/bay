import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { notificationState } from "../test-native-stub.mjs";
import { capabilities } from "../test-platform-stub.mjs";
import { ensureNotificationPermission } from "./notificationPermission.ts";

beforeEach(() => {
  Object.assign(notificationState, { querySupported: true, permission: "granted", requested: false, queries: 0, requests: 0 });
});

test("a host without a permission query attempts native notification delivery", async () => {
  notificationState.querySupported = false;
  notificationState.permission = "denied";
  assert.equal(await ensureNotificationPermission(), true);
  assert.equal(notificationState.queries, 0);
  assert.equal(notificationState.requests, 0);
});

test("a host without notification support does not attempt delivery", async (t) => {
  const supported = capabilities.notifications;
  t.after(() => (capabilities.notifications = supported));
  capabilities.notifications = false;
  notificationState.querySupported = false;
  assert.equal(await ensureNotificationPermission(), false);
  assert.equal(notificationState.queries, 0);
});

for (const permission of ["granted", "provisional"]) {
  test(`${permission} permits delivery without requesting a new grant`, async () => {
    notificationState.permission = permission;
    assert.equal(await ensureNotificationPermission(), true);
    assert.equal(notificationState.queries, 1);
    assert.equal(notificationState.requests, 0);
  });
}

for (const requested of [true, false]) {
  test(`an undetermined permission uses the request result ${requested}`, async () => {
    Object.assign(notificationState, { permission: "notDetermined", requested });
    assert.equal(await ensureNotificationPermission(), requested);
    assert.equal(notificationState.requests, 1);
  });
}

test("a denied permission does not permit delivery", async () => {
  notificationState.permission = "denied";
  assert.equal(await ensureNotificationPermission(), false);
  assert.equal(notificationState.requests, 0);
});
