import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin") {
  console.log("macOS image checks require AppKit; skipped on this platform");
  process.exit(0);
}

const imageDirectory = new URL("../../../node_modules/expo-image/ios/", import.meta.url);
const readImageSource = (name) => readFileSync(new URL(name, imageDirectory), "utf8");
const withoutExpoImport = (source) => source.replace("import ExpoModulesCore", "");
const utilities = readImageSource("ImageUtils.swift");

const between = (start, end) => {
  const from = utilities.indexOf(start);
  const to = utilities.indexOf(end, from);
  assert(from >= 0 && to > from, "Expo Image helper boundaries changed; update the native test extraction");

  return utilities.slice(from, to);
};

// Compile the installed implementation, including its macOS branches. The fixture only replaces
// Expo's record-conversion types, which are irrelevant to geometry and AppKit bitmap drawing.
const fixture = readFileSync(new URL("./image-macos-fixture.swift", import.meta.url), "utf8");
const [support, checks] = fixture.split("// IMAGE_IMPLEMENTATION");

assert(checks, "Native image fixture is missing its implementation marker");

const source = [
  support,
  readImageSource("ImagePlatform.swift"),
  readImageSource("Blurhash.swift"),
  readImageSource("Thumbhash.swift"),
  withoutExpoImport(readImageSource("ContentFit.swift")),
  withoutExpoImport(readImageSource("ContentPosition.swift")),
  between("func idealSize(", "/**\n The image source that fits best"),
  between("extension CGSize {", "func makeNSError("),
  checks,
].join("\n");

const directory = mkdtempSync(join(tmpdir(), "bay-image-macos-"));

try {
  const swiftFile = join(directory, "main.swift");
  const executable = join(directory, "image-checks");
  writeFileSync(swiftFile, source);
  execFileSync("xcrun", ["swiftc", swiftFile, "-o", executable], { stdio: "inherit" });
  execFileSync(executable, { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
