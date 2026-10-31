import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCode } from "../src/runner.ts";

const skill = readFileSync(join(import.meta.dir, "../src/skill/SKILL.md"), "utf8");
const blocks = (language: string) => [...skill.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1]!);
const commands = blocks("sh").flatMap((block) => [...block.matchAll(/^bay exec (?:--json )?'(.*)'$/gm)].map((match) => match[1]!));

it("finds the skill's recipes", () => {
  expect(blocks("ts").length).toBeGreaterThan(0);
  expect(commands.length).toBeGreaterThan(0);
});

it.each([...blocks("ts"), ...commands])("compiles the recipe %s", (recipe) => {
  expect(() => compileCode(recipe, "recipe.ts")).not.toThrow();
});

it("installs the skill with its API reference", () => {
  const project = mkdtempSync(join(tmpdir(), "bay-skill-test-"));
  try {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/bay.ts"), "skills", "install", "--project", "--target", "claude-code"], {
      cwd: project,
    });
    expect(result.exitCode).toBe(0);
    const folder = join(project, ".claude", "skills", "bay");
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(skill);
    expect(readFileSync(join(folder, "references", "api.md"), "utf8")).toContain("# The `bay exec` API");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
