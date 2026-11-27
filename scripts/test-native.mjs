import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const suite = process.argv[2];

if (suite !== "sync" && suite !== "import") throw new Error("Expected sync or import suite");

const root = fileURLToPath(new URL("../", import.meta.url));

// The Swift packages link Bay's desktop Rust library (bay-sync, bay-import); build it first. Windows' runner builds its own.
if (process.platform !== "win32") {
  const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`, MACOSX_DEPLOYMENT_TARGET: "14.0" };
  const cargo = spawnSync("cargo", ["build", "--locked", "--package", "bay-desktop"], { cwd: `${root}/packages/rust`, env, stdio: "inherit" });

  if (cargo.status !== 0) process.exit(cargo.status ?? 1);
}

const result =
  process.platform === "win32"
    ? spawnSync("python", ["scripts/windows/test-native.py", "--suite", suite], { cwd: root, stdio: "inherit" })
    : spawnSync("bash", ["../../scripts/swift-test.sh", "--scratch-path", `${process.env.TMPDIR || "/tmp"}/bay-${suite}-swiftpm`], {
        cwd: `${root}/packages/${suite}`,
        stdio: "inherit",
      });

if (result.error) throw result.error;

process.exitCode = result.status ?? 1;
