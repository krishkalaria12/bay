// Real-browser checks for the WebGL2 backend: every GLSL port compiles and links, the backdrop's grain has the
// contracted strength and cell size at DPR 1 and 2, the animated effects draw, a lost context comes back, and a
// settled scene stops drawing. Runs the package's own modules in headless Chromium with SwiftShader, so it needs
// no GPU.
//   node scripts/check-web-shaders.mjs [path to chromium]
import { findChromium, withChromium } from "./browser.mjs";

let failed = false;
await withChromium(
  { browser: findChromium(process.argv[2]), args: ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  async (open) => {
    for (const dpr of [1, 2]) {
      for (const check of await open("fixture.html", { dpr, timeout: 30000 })) {
        console.log(`${check.ok ? "ok  " : "FAIL"} dpr ${dpr} · ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
        if (!check.ok) failed = true;
      }
    }
  },
);
process.exitCode = failed ? 1 : 0;
