import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const entry = resolve(import.meta.dir, "../bin/bay.ts");
describe("CLI argument validation", () => {
  it.each(
    [
      ["exec", "--port"],
      ["exec", "1", "--port", "123abc"],
      ["exec", "1", "--timeout", "NaN"],
      ["exec", "1", "--timeout", "-1"],
      ["exec", "1", "--timeout", "Infinity"],
      ["exec", "1", "--unknown"],
      ["exec", "1", "2"],
      ["scripts", "new", "--match"],
      ["scripts", "test", "file.ts", "--wait", "NaN"],
      ["scripts", "install", "file.ts", "--data-dir"],
      ["scripts", "list", "--data-dir"],
      ["skills", "install", "--target"],
      ["skills", "install", "--target", "constructor"],
      ["skills", "typo"],
    ].map((args) => [args]),
  )("rejects invalid arguments %j", (args: string[]) => {
    const result = Bun.spawnSync([process.execPath, entry, ...args], { env: { ...process.env, BAY_CDP_URL: "", BAY_DATA_DIR: "/nonexistent" } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toMatch(/bay (exec|scripts|skills):/);
  });
});
