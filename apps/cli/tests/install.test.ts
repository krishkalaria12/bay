import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installer = resolve(import.meta.dir, "../install.sh");
const macos = process.platform === "darwin" && process.arch === "arm64";

describe.skipIf(!macos)("CLI installer", () => {
  let root: string;
  let home: string;
  let bin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bay-installer-test-"));
    home = join(root, "CLI");
    bin = join(root, "bin");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function archive(version: string, outsideLink = false): string {
    const packageName = `bay-cli-${version}`;
    const source = join(root, "packages", packageName);
    mkdirSync(join(source, "bin"), { recursive: true });
    const executable = join(source, "bin", "bay");
    if (outsideLink) symlinkSync("/usr/bin/true", executable);
    else {
      writeFileSync(executable, `#!/bin/sh\nprintf 'bay ${version}\\n'\n`);
      chmodSync(executable, 0o755);
    }
    const output = join(root, `bay-cli-${version}-macos-arm64.tar.gz`);
    const tar = Bun.spawnSync(["/usr/bin/tar", "-czf", output, "-C", join(root, "packages"), packageName], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    expect(tar.exitCode).toBe(0);
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(output)).digest("hex");
    writeFileSync(`${output}.sha256`, `${digest}\n`);
    return output;
  }

  function install(version: string, path = archive(version)) {
    return Bun.spawnSync(["/bin/sh", installer, "--version", version], {
      env: { ...process.env, BAY_CLI_HOME: home, BAY_CLI_BIN_DIR: bin, BAY_CLI_URL: pathToFileURL(path).href },
    });
  }

  it("installs a verified binary and updates its current link", () => {
    const result = install("1.0.0");
    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(home, "current"))).toBe("1.0.0");
    expect(readlinkSync(join(bin, "bay"))).toBe(join(home, "current", "bin", "bay"));
    expect(existsSync(join(home, "1.0.0", ".leases"))).toBe(true);
    expect(
      Bun.spawnSync([join(bin, "bay"), "--version"])
        .stdout.toString()
        .trim(),
    ).toBe("bay 1.0.0");
  });

  it("preserves the current install on a checksum mismatch", () => {
    expect(install("1.0.0").exitCode).toBe(0);
    const next = archive("1.0.1");
    writeFileSync(`${next}.sha256`, `${"0".repeat(64)}\n`);
    const result = install("1.0.1", next);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("checksum mismatch");
    expect(readlinkSync(join(home, "current"))).toBe("1.0.0");
  });

  it("keeps leased versions across upgrades and prunes them after release", () => {
    expect(install("1.0.0").exitCode).toBe(0);
    const lease = join(home, "1.0.0", ".leases", String(process.pid));
    writeFileSync(lease, "");
    expect(install("1.0.1").exitCode).toBe(0);
    expect(install("1.0.2").exitCode).toBe(0);
    expect(existsSync(join(home, "1.0.0"))).toBe(true);
    rmSync(lease);
    expect(install("1.0.3").exitCode).toBe(0);
    expect(existsSync(join(home, "1.0.0"))).toBe(false);
    expect(existsSync(join(home, "1.0.2"))).toBe(true);
  });

  it("waits for a running install before it removes the command", async () => {
    expect(install("1.0.0").exitCode).toBe(0);
    const installing = Bun.spawn(["/usr/bin/lockf", "-k", join(home, ".lock"), "/bin/sleep", "30"]);
    while (!Bun.spawnSync(["/usr/bin/lockf", "-t", "0", join(home, ".lock"), "/usr/bin/true"]).exitCode) await Bun.sleep(20);
    const uninstall = Bun.spawn(["/bin/sh", installer, "--uninstall"], {
      env: { ...process.env, BAY_CLI_HOME: home, BAY_CLI_BIN_DIR: bin },
      stdout: "pipe",
    });
    await Bun.sleep(300);
    expect(readlinkSync(join(bin, "bay"))).toBe(join(home, "current", "bin", "bay"));
    installing.kill();
    await installing.exited;
    expect(await uninstall.exited).toBe(0);
    expect(existsSync(join(bin, "bay"))).toBe(false);
    expect(existsSync(join(home, "1.0.0"))).toBe(false);
  });

  it("refuses to replace an unrelated bay command", () => {
    mkdirSync(bin);
    writeFileSync(join(bin, "bay"), "existing command");
    const result = install("1.0.0");
    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(bin, "bay"), "utf8")).toBe("existing command");
  });

  it("rejects archive links outside the package", () => {
    const result = install("1.0.0", archive("1.0.0", true));
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("links that point outside");
    expect(existsSync(join(home, "current"))).toBe(false);
  });
});
