// Opens a separate Debug browser with fake, offline folders. Never writes to the user's Bay profile.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../../../scripts/lib/instance.mjs";
import { nestedFoldersFixture } from "./fixtures/nested-folders.mjs";

const app = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../build-dev/Build/Products/Debug/Bay.app", import.meta.url));
if (!existsSync(join(app, "Contents/Info.plist"))) throw new Error("Build the Debug app first with pnpm dev:app, or pass a Debug Bay.app path");
const status = await fetch("http://localhost:8081/status")
  .then((r) => r.text())
  .catch(() => "");
if (!status.includes("packager-status:running")) throw new Error("Start Metro with pnpm dev before opening the folder playground");
const data = mkdtempSync(join(tmpdir(), "bay-folder-playground-"));
writeFileSync(join(data, "session.json"), JSON.stringify(nestedFoldersFixture(), null, 2));
writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
execFileSync("open", [
  "-n",
  "--env",
  `BAY_DATA_DIR=${data}`,
  "--env",
  "BAY_JS_LOCATION=localhost:8081",
  "--env",
  `BAY_REMOTE_DEBUGGING_PORT=${await freePort()}`,
  app,
]);
console.log(`Opened Folder playground. Fake profile: ${data}`);
