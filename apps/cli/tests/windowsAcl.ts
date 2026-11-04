import { join } from "node:path";

/** Runs icacls on `path`; its exit code. */
export function icacls(path: string, ...args: string[]): number {
  const tool = join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  return Bun.spawnSync([tool, path, ...args]).exitCode;
}

/**
 * On Windows, the owner and DACL the browser publishes its control file with. An elevated runner's new files belong to
 * Administrators, and they inherit the temp folder's grants. Elsewhere, the fixture's mode 0600 already says this.
 */
export function makeControlFilePrivate(path: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) throw new Error("test needs the current Windows user");
  if (icacls(path, "/setowner", user) !== 0) throw new Error("couldn't take ownership of the control file");
  if (icacls(path, "/inheritance:r", "/grant:r", `${user}:(F)`) !== 0) throw new Error("couldn't make the control file private");
}
