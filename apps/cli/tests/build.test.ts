import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, parseMeta } from "../src/userscript.ts";

describe("userscript bundling", () => {
  let root: string;
  let entry: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bay-build-test-"));
    mkdirSync(join(root, "script"));
    entry = join(root, "script", "a.user.ts");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([false, true])("rejects imports outside the script folder with sourcemap=%s", async (sourcemap) => {
    writeFileSync(join(root, "secret.ts"), "export const secret = 'private';");
    writeFileSync(entry, "import { secret } from '../secret.ts'; console.log(secret);");
    await expect(build(entry, { sourcemap })).rejects.toThrow("imports must stay inside");
  });

  it("rejects symlinks into Bay data", async () => {
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "secret.ts"), "export const secret = 'private';");
    symlinkSync(join(root, "data", "secret.ts"), join(root, "script", "helper.ts"));
    writeFileSync(entry, "import { secret } from './helper.ts'; console.log(secret);");
    await expect(build(entry, { dataDirs: [join(root, "data")] })).rejects.toThrow("Bay's data folder");
  });

  it.each([false, true])("bundles local imports with sourcemap=%s", async (sourcemap) => {
    writeFileSync(join(root, "script", "helper.ts"), "export const message: string = 'hello';");
    writeFileSync(entry, "import { message } from './helper.ts'; console.log(message);");
    const result = await build(entry, { sourcemap });
    expect(result.js).toContain("hello");
    expect(Boolean(result.sourcemap)).toBe(sourcemap);
  });

  it("rejects prototype properties as injection worlds", () => {
    expect(() => parseMeta("// ==UserScript==\n// @inject-into constructor\n// ==/UserScript==", "a.ts")).toThrow("use page, content or auto");
  });
});
