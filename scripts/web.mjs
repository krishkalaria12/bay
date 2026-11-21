import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];

if (mode !== "dev" && mode !== "build") throw new Error("Expected web dev or build");

const cwd = fileURLToPath(new URL("../apps/browser/", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/expo/bin/cli", import.meta.url));

// A build clears Metro's cache: its transforms inline EXPO_PUBLIC_ values and don't key on them, so a switch of
// BAY_WEB_SHADERS would otherwise keep the last build's.
const args = mode === "build" ? ["export", "--platform", "web", "--clear"] : ["start", "--web", "--port", "8090"];

const child = spawn(process.execPath, [cli, ...args, ...process.argv.slice(3)], {
  cwd,
  // The shader views draw with WebGL2, over a CSS base for a GPU without it. BAY_WEB_SHADERS=0 builds the CSS alone.
  env: { ...process.env, BAY_WEB: "1", EXPO_PUBLIC_BAY_WEB_SHADERS: process.env.BAY_WEB_SHADERS === "0" ? "0" : "1" },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
