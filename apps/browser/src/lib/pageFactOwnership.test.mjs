import assert from "node:assert/strict";
import { test } from "node:test";
import { installNativeTransport } from "../../../../packages/platform/src/nativeBridge.ts";
import { pageFactsInCoordinator as nativePageFactsInCoordinator } from "./pageFactOwnership.ts";
import { pageFactsInCoordinator } from "./pageFactOwnership.web.ts";

test("native macOS page facts stay local without a web host transport", () => {
  assert.equal(nativePageFactsInCoordinator(), false);
});

for (const platform of ["linux", "windows"]) {
  test(`${platform} web page facts follow the host's sharedRuntime constant`, async (t) => {
    const info = { contractVersion: 2, platform, modules: ["BayShell"], views: [], constants: {} };
    const connection = installNativeTransport({
      getHostInfo: () => info,
      invoke: async () => {
        assert.fail("page ownership must only read the local host snapshot");
      },
      subscribe: () => {
        assert.fail("page ownership must not subscribe to native events");
      },
    });
    t.after(() => connection.remove());
    if (platform === "linux") {
      const host = await import("../../../../packages/platform/src/os.web.ts");
      assert.equal(host.platformOS, "linux");
      assert.equal(host.isWindows, false);
    }
    assert.equal(pageFactsInCoordinator(), false);
    info.constants.BayShell = {};
    assert.equal(pageFactsInCoordinator(), false);
    for (const sharedRuntime of [false, "true", 1, null]) {
      info.constants.BayShell.sharedRuntime = sharedRuntime;
      assert.equal(pageFactsInCoordinator(), false);
    }
    info.constants.BayShell.sharedRuntime = true;
    assert.equal(pageFactsInCoordinator(), true);
    info.constants.BayShell.sharedRuntime = false;
    assert.equal(pageFactsInCoordinator(), false);
  });
}
