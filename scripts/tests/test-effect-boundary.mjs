// Effect belongs to the desktop app, the mobile app and the bay CLI: only apps/browser, apps/mobile and apps/cli depend
// on it, the shared packages and the other apps stay free of it, the apps' pure state code never reaches it, and no
// Node, Bun or DOM platform adapter goes into Hermes. The CLI is a standalone Bun tool with its own lockfile: its Bun
// platform layer is its own. Mobile's engine module (@bay/engine) is the native contract and stays free of it too.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

const SKIP = new Set(["node_modules", "dist", "build", "ios", "android", "macos", "Pods", ".turbo", "vendor", "fixtures", "target"]);

const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](effect(?:\/[^"']*)?|@effect\/[^"']+)["']/g;

// The source files under a folder, as the bundler would find them.
function sources(dir) {
  const out = [];

  const walk = (at) => {
    for (const name of readdirSync(at)) {
      if (SKIP.has(name) || name.startsWith(".")) continue;

      const full = path.join(at, name);

      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(m?[jt]sx?)$/.test(name)) out.push(full);
    }
  };

  walk(dir);

  return out;
}

const effectImports = (file) => [...readFileSync(file, "utf8").matchAll(IMPORT)].map((m) => m[1]);

const DESKTOP = path.join("apps", "browser");
const MOBILE = path.join("apps", "mobile");
const CLI = path.join("apps", "cli");

/** The apps that run on Effect. */
const EFFECT_APPS = new Set([DESKTOP, MOBILE, CLI]);

const workspaces = () =>
  ["apps", "packages"].flatMap((group) =>
    readdirSync(path.join(ROOT, group))
      .map((name) => path.join(ROOT, group, name))
      .filter((dir) => statSync(dir).isDirectory()),
  );

test("only the desktop app, the mobile app and the CLI depend on effect", () => {
  const pins = {};

  for (const dir of workspaces()) {
    let manifest;

    try {
      manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }

    const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
    const named = Object.keys(deps).filter((name) => name === "effect" || name.startsWith("@effect/"));
    const rel = path.relative(ROOT, dir);

    if (named.includes("effect")) pins[rel] = deps.effect;

    if (rel === DESKTOP) assert.deepEqual(named, ["effect"], "the desktop app pins effect alone");
    else if (rel === MOBILE) assert.deepEqual(named, ["effect"], "the mobile app pins effect alone");
    else if (rel === CLI) {
      assert.deepEqual(named.sort(), ["@effect/platform-bun", "effect"], "the CLI pins effect and its Bun platform");
      assert.equal(deps.effect, deps["@effect/platform-bun"], "the CLI's effect and its Bun platform are one release");
    } else assert.deepEqual(named, [], `${rel} stays free of effect`);
  }

  // The repo never runs two Effect releases: a version moves in one commit for every app.
  assert.equal(new Set(Object.values(pins)).size, 1, `every app pins one effect release: ${JSON.stringify(pins)}`);
});

test("no shared package or other app imports effect", () => {
  for (const dir of workspaces()) {
    const rel = path.relative(ROOT, dir);

    if (EFFECT_APPS.has(rel)) continue;

    for (const file of sources(dir)) assert.deepEqual(effectImports(file), [], path.relative(ROOT, file));
  }
});

test("the mobile app imports core effect only, and its engine and tab model none of it", () => {
  const app = path.join(ROOT, MOBILE);

  for (const file of sources(path.join(app, "src"))) {
    const found = effectImports(file);

    // Node, Bun and browser-DOM platform adapters have no place in Hermes.
    assert.deepEqual(
      found.filter((name) => name.startsWith("@effect/")),
      [],
      `${path.relative(ROOT, file)} imports a platform package`,
    );
  }

  // The engine is the native contract the Chromium work changes underneath: it stays Promise-based.
  for (const file of sources(path.join(app, "modules"))) assert.deepEqual(effectImports(file), [], path.relative(ROOT, file));

  // The tab model is a pure reducer over one versioned document: services dispatch into it, it never reaches them.
  const model = path.join(app, "src", "store", "model.ts");

  assert.deepEqual(effectImports(model), [], `${path.relative(ROOT, model)} imports effect`);
  assert.doesNotMatch(readFileSync(model, "utf8"), /effect\/runtime/, `${path.relative(ROOT, model)} reaches the runtime`);
});

test("the desktop app imports core effect only, and its store code none of it", () => {
  const src = path.join(ROOT, "apps", "browser", "src");

  for (const file of sources(src)) {
    const rel = path.relative(src, file);
    const found = effectImports(file);

    // Node, Bun and browser-DOM platform adapters have no place in Hermes.
    assert.deepEqual(
      found.filter((name) => name.startsWith("@effect/")),
      [],
      `${rel} imports a platform package`,
    );

    // The store is plain synchronous state: no effect, and no runtime. Its tests may drive a service.
    if (rel.startsWith(`store${path.sep}`) && !/\.test\.m?[jt]s$/.test(rel)) {
      assert.deepEqual(found, [], `${rel} imports effect`);
      assert.doesNotMatch(readFileSync(file, "utf8"), /effect\/runtime/, `${rel} reaches the runtime`);
    }
  }
});
