import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const suite = process.argv[2];
if (suite !== "sync" && suite !== "import") throw new Error("Expected sync or import suite");
const root = fileURLToPath(new URL("../", import.meta.url));
const result =
  process.platform === "win32"
    ? spawnSync("python", ["scripts/windows/test-native.py", "--suite", suite], { cwd: root, stdio: "inherit" })
    : spawnSync("bash", ["../../scripts/swift-test.sh", "--scratch-path", `${process.env.TMPDIR || "/tmp"}/bay-${suite}-swiftpm`], {
        cwd: `${root}/packages/${suite}`,
        stdio: "inherit",
      });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
