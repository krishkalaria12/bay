import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The Metal compiler comes with Xcode, not the Command Line Tools: use Xcode's without changing xcode-select (as
// scripts/swift-test.sh does for XCTest).
const XCODE = "/Applications/Xcode.app/Contents/Developer";
const hasMetal = () => {
  try {
    execFileSync("xcrun", ["-sdk", "macosx", "--find", "metal"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};
if (!process.env.DEVELOPER_DIR && !hasMetal() && existsSync(XCODE)) process.env.DEVELOPER_DIR = XCODE;
if (!hasMetal()) {
  console.error("Checking shaders needs Xcode's Metal compiler. Set DEVELOPER_DIR to its Contents/Developer directory.");
  process.exit(1);
}

const iosDir = fileURLToPath(new URL("../ios/", import.meta.url));
const read = (f) => readFileSync(join(iosDir, f), "utf8");
const block = (src, name) => src.match(new RegExp(`let ${name} = """\\n([\\s\\S]*?)\\n"""`))?.[1];

const vertex = block(read("MetalSurface.swift"), "fullscreenVertexSource");
const out = mkdtempSync(join(tmpdir(), "shaders-"));
let failed = false;
for (const file of readdirSync(iosDir).filter((f) => f.endsWith(".swift"))) {
  const src = read(file);
  for (const [, name] of src.matchAll(/^let (\w+Source) = """/gm)) {
    if (name === "fullscreenVertexSource") continue;
    const path = join(out, `${name}.metal`);
    writeFileSync(path, vertex + "\n" + block(src, name));
    try {
      execFileSync("xcrun", ["-sdk", "macosx", "metal", "-c", path, "-o", path + ".air"], { stdio: "pipe" });
      console.log(`✓ ${file} ${name}`);
    } catch (e) {
      failed = true;
      console.error(`✗ ${file} ${name}\n${e.stderr}`);
    }
  }
}
process.exit(failed ? 1 : 0);
