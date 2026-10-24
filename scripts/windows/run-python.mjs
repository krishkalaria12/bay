import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error("Expected a Python script or -m module");
const target = entry.startsWith("-") ? entry : fileURLToPath(new URL(entry, import.meta.url));
const result = spawnSync(process.env.BAY_PYTHON || (process.platform === "win32" ? "python" : "python3"), [target, ...args], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
