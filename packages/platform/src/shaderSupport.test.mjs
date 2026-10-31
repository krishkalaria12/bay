import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilitiesFor } from "./capabilities.ts";

const fakeDoc = (gl, calls) => ({
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: (type, options) => {
      calls.push({ type, options });
      if (gl instanceof Error) throw gl;
      return gl;
    },
  }),
});

test("the probe asks for full-speed WebGL2 once and releases it", async () => {
  const { webgl2Supported } = await import(`./shaderSupport.web.ts?ok`);
  const calls = [];
  let lost = 0;
  const gl = { getExtension: (name) => (name === "WEBGL_lose_context" ? { loseContext: () => lost++ } : null) };
  assert.equal(webgl2Supported(fakeDoc(gl, calls)), true);
  assert.equal(webgl2Supported(fakeDoc(null, calls)), true, "memoized");
  assert.deepEqual(calls, [{ type: "webgl2", options: { failIfMajorPerformanceCaveat: true } }]);
  assert.equal(lost, 1);
});

for (const [name, gl] of [
  ["refused", null],
  ["throws", new Error("blocked")],
]) {
  test(`the probe reports no WebGL2 when the context is ${name}`, async () => {
    const { webgl2Supported } = await import(`./shaderSupport.web.ts?${name}`);
    assert.equal(webgl2Supported(fakeDoc(gl, [])), false);
  });
}

test("the probe without a DOM is false", async () => {
  const { webgl2Supported } = await import(`./shaderSupport.web.ts?nodom`);
  assert.equal(webgl2Supported(undefined), false);
});

test("shaders follow the probe on the web hosts and the modules on macOS", () => {
  const all = () => true,
    none = () => false;
  for (const os of ["windows", "linux"]) {
    assert.equal(capabilitiesFor(os, all).shaders, false);
    assert.equal(capabilitiesFor(os, none, true).shaders, true);
    // The probe is independent of the host's backdrop treatment.
    assert.equal(capabilitiesFor(os, none, true).vibrancy, false);
  }
  assert.equal(capabilitiesFor("macos", all).shaders, true);
  assert.equal(capabilitiesFor("macos", none, true).shaders, false);
});
