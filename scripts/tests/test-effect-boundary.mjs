// Effect is the desktop app's own: only apps/browser depends on it, the shared packages and the other apps stay
// free of it, the app's pure store code never reaches it, and no Node, Bun or DOM platform adapter goes into Hermes.
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

const workspaces = () =>
  ["apps", "packages"].flatMap((group) =>
    readdirSync(path.join(ROOT, group))
      .map((name) => path.join(ROOT, group, name))
      .filter((dir) => statSync(dir).isDirectory()),
  );

test("only the desktop app depends on effect", () => {
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

    if (rel === path.join("apps", "browser")) assert.deepEqual(named, ["effect"], "the desktop app pins effect alone");
    else assert.deepEqual(named, [], `${rel} stays free of effect`);
  }
});

test("no shared package or other app imports effect", () => {
  for (const dir of workspaces()) {
    if (path.relative(ROOT, dir) === path.join("apps", "browser")) continue;

    for (const file of sources(dir)) assert.deepEqual(effectImports(file), [], path.relative(ROOT, file));
  }
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
