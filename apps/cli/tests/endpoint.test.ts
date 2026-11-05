import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumRoot, documentsRoot, fromControlFile, installedDataDir } from "../src/endpoint.ts";
import { checkControlFile } from "../src/controlFileSecurity.ts";
import { CONTROL_FILE_TIMEOUT, icacls, makeControlFilePrivate } from "./windowsAcl.ts";

describe("desktop data layout", () => {
  it("uses the native host's Chromium directory and document folder", () => {
    expect(chromiumRoot("/data", "darwin")).toBe(join("/data", "Chromium"));
    expect(chromiumRoot("/data", "linux")).toBe("/data");
    expect(chromiumRoot("/data", "win32")).toBe("/data");
    expect(documentsRoot("/data", "linux")).toBe(join("/data", "BayDocuments"));
    expect(installedDataDir("linux", { XDG_CONFIG_HOME: "/custom" }, "/home/user")).toBe(join("/custom", "bay"));
    expect(installedDataDir("win32", { LOCALAPPDATA: "/local" }, "/home/user")).toBe(join("/local", "Bay", "User Data"));
  });
});

describe.skipIf(process.platform === "win32")("private control files", () => {
  it("rejects a readable token file and a link before returning its endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "bay-control-test-"));
    try {
      const path = join(root, "BayControl.json");
      writeFileSync(path, JSON.stringify({ port: 1234, browser: "/devtools/browser/test", token: "private-test-token", pid: process.pid }), { mode: 0o600 });
      expect(fromControlFile(path).explicit).toBe(false);
      chmodSync(path, 0o644);
      expect(() => fromControlFile(path)).toThrow("mode 0600");
      symlinkSync(path, join(root, "linked.json"));
      expect(() => fromControlFile(join(root, "linked.json"))).toThrow("symbolic link");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a replaced path while retaining the original open descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "bay-control-test-"));
    const path = join(root, "token");
    writeFileSync(path, "original", { mode: 0o600 });
    const fd = openSync(path, "r");
    try {
      rmSync(path);
      mkdirSync(path);
      expect(() => checkControlFile(path, fd)).toThrow("same regular file");
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "win32")("private Windows control files", () => {
  it(
    "accepts an owner-only DACL and refuses a token inherited by other principals",
    () => {
      const root = mkdtempSync(join(tmpdir(), "bay-control-acl-test-"));
      try {
        const path = join(root, "BayControl.json");
        writeFileSync(path, JSON.stringify({ port: 1234, browser: "/devtools/browser/test", token: "private-test-token", pid: process.pid }));
        makeControlFilePrivate(path);
        expect(fromControlFile(path).explicit).toBe(false);
        expect(icacls(path, "/grant", "*S-1-1-0:(R)")).toBe(0);
        expect(() => fromControlFile(path)).toThrow("another principal");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    CONTROL_FILE_TIMEOUT,
  );
});
