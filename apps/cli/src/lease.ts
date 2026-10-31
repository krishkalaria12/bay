// A lease marks an installed version as in use, so an installer upgrading the CLI leaves it in place while a command
// from it is still running. Only an installed layout has the `.leases` folder: a dev run from the source tree doesn't.
import { closeSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

type Lease = { release: () => Promise<void> };

const NONE: Lease = { release: async () => {} };

export function takeLease(): Lease {
  let root: string;
  try {
    root = leaseRoot(process.execPath);
  } catch {
    return NONE;
  }
  const leases = join(root, ".leases");
  try {
    if (!statSync(leases).isDirectory()) return NONE;
    const path = join(leases, String(process.pid));
    closeSync(openSync(path, "w", 0o644));
    return {
      release: async () => {
        try {
          unlinkSync(path);
        } catch {}
      },
    };
  } catch {
    return NONE;
  }
}

// Kept for the installer's copy of the layout rule.
export function leaseRoot(execPath: string): string {
  return dirname(dirname(realpathSync(execPath)));
}

export function makeLeaseDir(root: string): void {
  mkdirSync(join(root, ".leases"), { recursive: true, mode: 0o755 });
}
