import { join } from "node:path";

/** Runs icacls on `path`; its exit code. */
export function icacls(path: string, ...args: string[]): number {
  const tool = join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  return Bun.spawnSync([tool, path, ...args]).exitCode;
}

// A whole new security descriptor: icacls only edits the one it finds, and a runner's new files can carry grants of
// their own besides the ones they inherit.
const PRIVATE_ACL = `
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $env:BAY_TEST_ACL_PATH -AclObject $acl
`;

/**
 * On Windows, the owner and DACL the browser publishes its control file with: only the current user, who also owns it.
 * An elevated runner's new files belong to Administrators. Elsewhere, the fixture's mode 0600 already says this.
 */
export function makeControlFilePrivate(path: string): void {
  if (process.platform !== "win32") return;
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = Bun.spawnSync([powershell, "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${PRIVATE_ACL}`], {
    env: { ...process.env, BAY_TEST_ACL_PATH: path },
  });
  if (result.exitCode !== 0) throw new Error(`couldn't make the control file private: ${result.stderr.toString()}`);
}
