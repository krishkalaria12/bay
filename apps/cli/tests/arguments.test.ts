import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const entry = resolve(import.meta.dir, "../bin/bay.ts");

describe("CLI argument validation", () => {
  it.each([
    [["exec", "1", "ws://127.0.0.1:9222/devtools/browser/test?token=argument-secret-12345"]],
    [["exec", "1", "--port", "ws://127.0.0.1:9222/devtools/browser/test?token=argument-secret-12345"]],
  ])("redacts control tokens from parser errors for %j", (args: string[]) => {
    const result = Bun.spawnSync([process.execPath, entry, ...args]);
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("token=***");
    expect(stderr).not.toContain("argument-secret-12345");
  });

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
