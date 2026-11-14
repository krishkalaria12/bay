#!/usr/bin/env node
// Installs Bay's Chromium for Android (bay-engine.aar, built by .github/workflows/android-engine.yml) where the app's
// build finds it: a local Maven repository in modules/bay-engine/android/engine, described by engine.properties.
//
//   node scripts/fetch-android-engine.mjs               the engine android-engine.json pins, from its release
//   node scripts/fetch-android-engine.mjs --from DIR    a built engine: DIR holds bay-engine.aar and engine.json
//
// The AAR is checked against its sha256 before anything is installed, and an engine is only installed when it offers
// the API this app was written against (ENGINE_API). Installing the same engine again does nothing.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** The org.bay.engine API the app's Kotlin uses (engine.json's `engineApi`); bump both together. */
export const ENGINE_API = 1;

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTarget = path.join(app, "modules/bay-engine/android/engine");
const pinFile = path.join(app, "android-engine.json");

/** The Maven version of a built engine: its Chromium and its engine id, from engine.json's `id`. */
export function engineVersion(manifest) {
  const match = /^bay-android-engine-([\d.]+)-[a-z0-9]+-([0-9a-f]+)$/.exec(manifest.id ?? "");

  if (!match) throw new Error(`engine.json has no engine id I can read: ${JSON.stringify(manifest.id)}`);

  return `${match[1]}-${match[2]}`;
}

export async function sha256(file) {
  const hash = createHash("sha256");

  await pipeline(createReadStream(file), hash);

  return hash.digest("hex");
}

/** Installs the engine in `source` (bay-engine.aar and engine.json) into `target`; returns the version installed. */
export async function install(source, target = defaultTarget) {
  const manifest = JSON.parse(await readFile(path.join(source, "engine.json"), "utf8"));

  if (manifest.engineApi !== ENGINE_API) {
    throw new Error(`this engine offers API ${manifest.engineApi}, and the app needs ${ENGINE_API}: build or pin the matching one`);
  }

  const expected = manifest.files?.["bay-engine.aar"]?.sha256;
  const aar = path.join(source, "bay-engine.aar");
  const actual = await sha256(aar);

  if (actual !== expected) throw new Error(`bay-engine.aar's sha256 is ${actual}, and engine.json says ${expected}`);

  const version = engineVersion(manifest);
  const properties = path.join(target, "engine.properties");

  if (existsSync(properties) && (await readFile(properties, "utf8")).includes(`version=${version}\n`)) return version;

  // A fresh directory, renamed into place, so a failed install never leaves half an engine.
  const draft = `${target}.tmp`;
  const artifact = path.join(draft, "repo/org/bay/engine/bay-engine", version);

  await rm(draft, { recursive: true, force: true });
  await mkdir(artifact, { recursive: true });
  await copyFile(aar, path.join(artifact, `bay-engine-${version}.aar`));
  await writeFile(path.join(artifact, `bay-engine-${version}.pom`), pom(version));
  await writeFile(path.join(draft, "engine.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(draft, "engine.properties"), `# Written by scripts/fetch-android-engine.mjs.\nversion=${version}\n`);
  await rm(target, { recursive: true, force: true });
  await rename(draft, target);

  return version;
}

/** The engine's Maven description: an AAR with no dependencies (the app adds the ones it leaves out). */
export function pom(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.bay.engine</groupId>
  <artifactId>bay-engine</artifactId>
  <version>${version}</version>
  <packaging>aar</packaging>
</project>
`;
}

/** Downloads the pinned engine's release files into a temporary directory and returns it. */
async function download(pin) {
  const directory = path.join(app, ".expo/android-engine-download");

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  for (const name of ["engine.json", "bay-engine.aar"]) {
    const response = await fetch(`${pin.release}/${name}`);

    if (!response.ok || !response.body) throw new Error(`couldn't download ${name}: HTTP ${response.status}`);

    await pipeline(Readable.fromWeb(response.body), createWriteStream(path.join(directory, name)));
  }

  return directory;
}

async function main(args) {
  const from = args.indexOf("--from");

  if (from !== -1) {
    const source = args[from + 1];

    if (!source) throw new Error("--from needs the directory that holds bay-engine.aar and engine.json");

    console.log(`android engine: installed ${await install(path.resolve(source))}`);

    return;
  }

  if (!existsSync(pinFile)) {
    throw new Error("no engine is pinned yet (android-engine.json): pass --from with a built engine");
  }

  const pin = JSON.parse(await readFile(pinFile, "utf8"));
  const installed = path.join(defaultTarget, "engine.json");

  if (existsSync(installed) && JSON.parse(await readFile(installed, "utf8")).id === pin.id) {
    console.log("android engine: already installed");

    return;
  }

  const source = await download(pin);
  const manifest = JSON.parse(await readFile(path.join(source, "engine.json"), "utf8"));

  // The pin names the engine; a release whose engine is another one is refused before it's installed.
  if (manifest.id !== pin.id) throw new Error(`the release holds ${manifest.id}, and android-engine.json pins ${pin.id}`);

  console.log(`android engine: installed ${await install(source)}`);
  await rm(source, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`android engine: ${error.message}`);
    process.exit(1);
  });
}
