// Real-browser checks for the WebGL2 backend: every GLSL port compiles and links, the backdrop's grain has the
// contracted strength and cell size at DPR 1 and 2, the animated effects draw, a lost context comes back, and a
// settled scene stops drawing. Runs the package's own modules in headless Chromium with SwiftShader, so it needs
// no GPU.
//   node scripts/check-web-shaders.mjs [path to chromium]
import { findChromium, withChromium } from "./browser.mjs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Use the application's Metro configuration to exercise the real React views, including their DOM lifecycle.
const app = fileURLToPath(new URL("../../../apps/browser/", import.meta.url));
const require = createRequire(new URL("../../../apps/browser/package.json", import.meta.url));
process.env.BAY_WEB = "1";
process.env.EXPO_PUBLIC_BAY_WEB_SHADERS = "1";
const { loadConfig } = require("metro-config");
const { runBuild } = require("metro");
const config = await loadConfig({ cwd: app, config: `${app}metro.config.js`, maxWorkers: 2 });
const { code } = await runBuild(config, {
  entry: fileURLToPath(new URL("../tests/web/components.tsx", import.meta.url)),
  platform: "web",
  dev: true,
  minify: false,
});

let failed = false;
await withChromium(
  {
    browser: findChromium(process.argv[2]),
    args: ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    scripts: { "/components.js": code },
  },
  async (open) => {
    for (const dpr of [1, 2]) {
      for (const check of await open("fixture.html", { dpr, timeout: 30000 })) {
        console.log(`${check.ok ? "ok  " : "FAIL"} dpr ${dpr} · ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
        if (!check.ok) failed = true;
      }
      for (const check of await open("components.html", { dpr, timeout: 30000 })) {
        console.log(`${check.ok ? "ok  " : "FAIL"} dpr ${dpr} · ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
        if (!check.ok) failed = true;
      }
    }
  },
);
process.exitCode = failed ? 1 : 0;
