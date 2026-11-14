import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ENGINE_API, engineVersion, install } from "../scripts/fetch-android-engine.mjs";

const id = "bay-android-engine-154.0.8037.58-arm64-5be51182f8fb98ba";

/** The engine.json fields install reads. */
interface EngineManifest {
  id?: string;
  engineApi?: number;
  files?: { "bay-engine.aar": { sha256: string } };
}

/** A built engine as the workflow publishes it: the AAR and its engine.json. */
async function builtEngine(overrides: EngineManifest = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bay-engine-"));
  const aar = Buffer.from("not really an aar");

  await writeFile(path.join(directory, "bay-engine.aar"), aar);
  await writeFile(
    path.join(directory, "engine.json"),
    JSON.stringify({
      id,
      engineApi: ENGINE_API,
      files: { "bay-engine.aar": { sha256: createHash("sha256").update(aar).digest("hex") } },
      ...overrides,
    }),
  );

  return directory;
}

test("an engine's Maven version is its Chromium and its engine id", () => {
  assert.equal(engineVersion({ id }), "154.0.8037.58-5be51182f8fb98ba");
  assert.throws(() => engineVersion({ id: "content-shell" }));
});

test("an engine installs as a local Maven repository the build reads", async () => {
  const source = await builtEngine();
  const target = path.join(source, "installed");

  assert.equal(await install(source, target), "154.0.8037.58-5be51182f8fb98ba");
  assert.equal(
    await readFile(path.join(target, "engine.properties"), "utf8"),
    "# Written by scripts/fetch-android-engine.mjs.\nversion=154.0.8037.58-5be51182f8fb98ba\n",
  );

  const artifact = path.join(target, "repo/org/bay/engine/bay-engine/154.0.8037.58-5be51182f8fb98ba");

  assert.equal(await readFile(path.join(artifact, "bay-engine-154.0.8037.58-5be51182f8fb98ba.aar"), "utf8"), "not really an aar");
  assert.match(await readFile(path.join(artifact, "bay-engine-154.0.8037.58-5be51182f8fb98ba.pom"), "utf8"), /<packaging>aar<\/packaging>/);
  await rm(source, { recursive: true, force: true });
});

test("an engine whose file doesn't match its checksum, or that offers another API, isn't installed", async () => {
  const corrupt = await builtEngine({ files: { "bay-engine.aar": { sha256: "0".repeat(64) } } });
  const other = await builtEngine({ engineApi: ENGINE_API + 1 });

  await assert.rejects(install(corrupt, path.join(corrupt, "installed")), /sha256/);
  await assert.rejects(install(other, path.join(other, "installed")), /API/);
  await rm(corrupt, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});
