import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { installNativeTransport, NATIVE_CONTRACT_VERSION } from "@bay/platform/nativeBridge";

installNativeTransport({
  getHostInfo: () => ({ contractVersion: NATIVE_CONTRACT_VERSION, platform: "linux", modules: [], views: [], constants: {} }),
  invoke: async () => '{"value":null}',
  subscribe: () => ({ remove() {} }),
});
// SwiftShader is intentional in this fixture, though the production capability probe rejects software GPUs.
const { capabilities } = require("@bay/platform");
capabilities.shaders = true;
const { AreaLight, EdgeLight, PowerUp } = require("../../src/index.web");

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (test()) return true;
    await wait(25);
  }
  return false;
}

async function run() {
  const style = { width: 400, height: 300 };
  for (const [name, component, props] of [
    ["AreaLight", AreaLight, { source: { x: 80, y: 80, width: 200, height: 100 } }],
    ["EdgeLight", EdgeLight, { rectFrame: { x: 50, y: 50, width: 300, height: 200 }, lightStart: { x: 0, y: 0 }, lightEnd: { x: 400, y: 300 } }],
    ["PowerUp", PowerUp, {}],
  ] as const) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      root.render(createElement(component, { ...props, style }));
      if (!(await until(() => !!host.querySelector("canvas")?.width))) throw new Error(`${name} did not mount a canvas`);
      const canvas = host.querySelector("canvas")!;
      const gl = canvas.getContext("webgl2")!;
      let draws = 0;
      const draw = gl.drawArrays.bind(gl);
      gl.drawArrays = (...args) => {
        draws++;
        draw(...args);
      };
      check(`${name} draws before context loss`, await until(() => draws > 0));
      const ext = gl.getExtension("WEBGL_lose_context")!;
      ext.loseContext();
      await until(() => gl.isContextLost());
      await wait(100);
      check(
        `${name} retains its canvas while showing the fallback`,
        host.querySelector("canvas") === canvas && getComputedStyle(canvas).visibility === "hidden",
      );
      const before = draws;
      ext.restoreContext();
      const recovered = await until(() => !gl.isContextLost() && draws > before && getComputedStyle(canvas).visibility === "visible");
      check(`${name} resumes drawing on the same visible canvas`, recovered && host.querySelector("canvas") === canvas);
    } finally {
      root.unmount();
      host.remove();
    }
  }

  // A failed allocation must not poison this component when an emitter is disabled and later enabled again.
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const source = { x: 80, y: 80, width: 200, height: 100 };
  try {
    root.render([0, 1, 2].map((key) => createElement(AreaLight, { key, source, style })));
    await until(() => host.querySelectorAll("canvas").length === 3);
    const denied = host.querySelectorAll("canvas")[2];
    check("a third animation uses its fallback", !!denied && (await until(() => getComputedStyle(denied).visibility === "hidden")));
    root.render(createElement(AreaLight, { key: 2, source: null, style }));
    await until(() => !host.querySelector("canvas"));
    root.render(createElement(AreaLight, { key: 2, source, style }));
    check(
      "an animation can retry after a slot becomes available",
      await until(() => {
        const canvas = host.querySelector("canvas");
        return !!canvas && getComputedStyle(canvas).visibility === "visible" && canvas.width > 0;
      }),
    );
  } finally {
    root.unmount();
    host.remove();
  }
}

run()
  .catch((error) => check("component fixture ran", false, String(error?.stack ?? error)))
  .finally(() => {
    Object.assign(window, { results });
  });
