// The live services (activity/index.ts): the calendar, the meeting groups and the alerts start only where the
// platform has a calendar. The platform is bound when the module loads, so each one gets its own process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const script = `
const { calendarChangedListeners } = await import("./src/test-native-stub.mjs");
const { createBrowserStore } = await import("./src/store/browserStore.ts");
const { startLive } = await import("./src/activity/index.ts");
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve)); };
globalThis.__DEV__ = false;
const store = createBrowserStore();
const stop = startLive(store);
await settle();
const started = calendarChangedListeners.size;
stop();
stop();
await settle();
console.log(JSON.stringify({ started, stopped: calendarChangedListeners.size }));
process.exit(0);
`;

const liveOn = (platform) =>
  JSON.parse(
    execFileSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--input-type=module", "-e", script], {
      env: { ...process.env, BAY_TEST_PLATFORM: platform },
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .at(-1),
  );

test("the calendar watcher starts on the Mac and stops with the live services", () => {
  assert.deepEqual(liveOn("macos"), { started: 1, stopped: 0 });
});

test("a platform without a calendar starts no calendar watcher", () => {
  assert.deepEqual(liveOn("windows"), { started: 0, stopped: 0 });
  assert.deepEqual(liveOn("linux"), { started: 0, stopped: 0 });
});
