import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// webNativeViews is what nativeViews.web exports. A module it loads that asks for a view at load time reaches nativeViews
// before it has finished, and the web app fails to start with "reading 'requireNativeViewManager'". No other test boots
// the app, so this one follows its value imports (a type import is erased).
const source = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/desktop/src");

const valueImports = (text) =>
  [...text.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)"/gm)].flatMap((match) => (!match[1] ? [match[2]] : []));

const resolve = (from, specifier) => {
  const base = join(dirname(from), specifier);

  return [".web.ts", ".web.tsx", ".ts", ".tsx"].map((extension) => base + extension).find(existsSync);
};

test("nothing webNativeViews loads reaches back into nativeViews", () => {
  const seen = new Set();

  const visit = (file, path) => {
    if (!file || seen.has(file)) return;
    seen.add(file);

    for (const specifier of valueImports(readFileSync(file, "utf8"))) {
      assert.ok(!specifier.endsWith("/nativeViews"), `${[...path, file.slice(source.length + 1)].join(" > ")} imports ${specifier}`);
      visit(resolve(file, specifier), [...path, file.slice(source.length + 1)]);
    }
  };

  visit(join(source, "webNativeViews.tsx"), []);
  assert.ok(seen.size > 3, "the imports were followed");
});
