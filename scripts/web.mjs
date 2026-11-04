import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "build") throw new Error("Expected web dev or build");
const cwd = fileURLToPath(new URL("../apps/browser/", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/expo/bin/cli", import.meta.url));
const args = mode === "build" ? ["export", "--platform", "web"] : ["start", "--web", "--port", "8090"];
const child = spawn(process.execPath, [cli, ...args, ...process.argv.slice(3)], {
  cwd,
  // BAY_WEB_SHADERS=1 draws the shader views with WebGL2; otherwise they keep their CSS (the rollback path).
  env: { ...process.env, BAY_WEB: "1", EXPO_PUBLIC_BAY_WEB_SHADERS: process.env.BAY_WEB_SHADERS === "1" ? "1" : "0" },
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
