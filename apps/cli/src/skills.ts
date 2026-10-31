import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import skillMd from "./skill/SKILL.md" with { type: "text" };
import apiMd from "./skill/references/api.md" with { type: "text" };

export const SKILL_NAME = "bay";

export const TARGETS: Record<string, [string, string]> = {
  general: [".agents/skills", ".agents/skills"],
  codex: [".agents/skills", ".agents/skills"],
  "claude-code": [".claude/skills", ".claude/skills"],
  cursor: [".cursor/skills", ".cursor/skills"],
  opencode: [".config/opencode/skills", ".opencode/skills"],
};

export function isOurs(folder: string): boolean {
  try {
    const head = readFileSync(join(folder, "SKILL.md"), "utf8").slice(0, 200);
    return head.startsWith("---\nname: bay\n");
  } catch {
    return false;
  }
}

export function destination(target: string, project: boolean): string {
  const [userDir, projectDir] = TARGETS[target] ?? [".agents/skills", ".agents/skills"];
  const base = project ? resolve(process.cwd(), projectDir) : resolve(homedir(), userDir);
  return join(base, SKILL_NAME);
}

export function installInto(folder: string): void {
  mkdirSync(dirname(folder), { recursive: true });
  if (existsSync(folder)) {
    const stat = lstatSync(folder);
    if (stat.isSymbolicLink() || !isOurs(folder)) {
      throw new Error(`${folder} exists and isn't the bay skill; move it away first`);
    }
  }

  const stagingParent = dirname(folder);
  const staging = mkdtempSync(join(stagingParent, ".bay-skill-"));
  try {
    const fresh = join(staging, SKILL_NAME);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "SKILL.md"), skillMd, "utf8");
    mkdirSync(join(fresh, "references"));
    writeFileSync(join(fresh, "references", "api.md"), apiMd, "utf8");
    if (existsSync(folder)) {
      const old = join(staging, "old");
      renameSync(folder, old);
    }
    renameSync(fresh, folder);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function install(targets: string[], project: boolean): number {
  const written = new Map<string, string[]>();
  const uniqueTargets = Array.from(new Set(targets));

  for (const target of uniqueTargets) {
    const dest = destination(target, project);
    const list = written.get(dest) || [];
    list.push(target);
    written.set(dest, list);
  }

  let status = 0;
  for (const [folder, names] of written.entries()) {
    try {
      installInto(folder);
    } catch (error) {
      process.stdout.write(`${names.join(", ")}: error ${error instanceof Error ? error.message : String(error)}\n`);
      status = 1;
      continue;
    }
    process.stdout.write(`${names.join(", ")}: ${folder}\n`);
  }
  return status;
}
