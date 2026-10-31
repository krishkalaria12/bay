import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseRoot } from "../src/lease.ts";

it("finds leases beside the installed version through the current symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "bay-lease-test-"));
  try {
    const version = join(root, "0.1.0");
    mkdirSync(join(version, "bin"), { recursive: true });
    mkdirSync(join(version, ".leases"));
    writeFileSync(join(version, "bin", "bay"), "binary");
    symlinkSync("0.1.0", join(root, "current"));
    expect(leaseRoot(join(root, "current", "bin", "bay"))).toBe(realpathSync(version));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
