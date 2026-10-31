import assert from "node:assert/strict";
import { test } from "node:test";
import { installNativeTransport } from "./nativeBridge.ts";

test("web Linux trusts only an explicit boolean host capability", async () => {
  let sequence = 0;
  for (const platform of ["linux", "windows"]) {
    for (const flag of [undefined, false, true, "true", 1, null]) {
      const connection = installNativeTransport({
        getHostInfo: () => ({
          contractVersion: 2,
          platform,
          modules: [],
          views: [],
          constants: { BayShell: flag === undefined ? {} : { globalWindowCoordinates: flag } },
        }),
        invoke: async () => {
          throw new Error("capability reads must not invoke native methods");
        },
        subscribe: () => ({ remove() {} }),
      });
      try {
        const { capabilities } = await import(`./os.web.ts?case=${sequence++}`);
        assert.equal(capabilities.globalWindowCoordinates, platform === "windows" || flag === true);
      } finally {
        connection.remove();
      }
    }
  }
});
