import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Build, checkGlob, checkMatch, manifestEntries, Meta } from "./userscript.ts";

export const LOCK_TIMEOUT = 30;
export const STATUS_TIMEOUT = 10;
export const STATUS_POLL = 100;
export const RENAME_SWAP = 0x2;
export const AT_FDCWD = -2;

export const MAX_FILE = 64 * 1024 * 1024;
export const MAX_MANIFEST = 256 * 1024;
export const MAX_ENTRIES = 256;
export const MAX_FILES_PER_ENTRY = 256;
export const MAX_FILES = 512;

export const EXTENSION_NAME = "Bay Scripts";
export const EXTENSION_DESCRIPTION = "Userscripts installed with the bay command.";
export const EXTENSION = "extension";
export const GENERATION = "generation";
export const STATUS = "status.json";
export const SOURCE_SUFFIXES = [".ts", ".mts", ".js", ".mjs"] as const;

export const MANIFEST_KEYS = new Set(["manifest_version", "name", "version", "description", "content_scripts"]);
export const ENTRY_KEYS = new Set(["matches", "exclude_matches", "include_globs", "exclude_globs", "js", "run_at", "all_frames", "world"]);
export const RUN_AT = new Set(["document_start", "document_end", "document_idle"]);
export const WORLDS = new Set(["MAIN", "ISOLATED"]);

const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
  renameatx_np: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
    returns: FFIType.i32,
  },
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

export class StoreError extends Error {
  override name = "StoreError";
}

function randomHex(bytes = 6): string {
  return randomBytes(bytes).toString("hex");
}

export function swap(first: string, second: string): void {
  const firstBuf = Buffer.from(`${first}\0`);
  const secondBuf = Buffer.from(`${second}\0`);
  const ret = libSystem.symbols.renameatx_np(AT_FDCWD, firstBuf, AT_FDCWD, secondBuf, RENAME_SWAP);
  if (ret !== 0) {
    throw new StoreError(`can't swap ${first} and ${second}`);
  }
}

export function readFileSafe(path: string): Buffer | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new StoreError(`${path} is a symbolic link`);
    }
    if (!stat.isFile()) {
      throw new StoreError(`${path} isn't a regular file`);
    }
    if (stat.size > MAX_FILE) {
      throw new StoreError(`${path} is too big`);
    }
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeAtomic(path: string, data: Buffer | string): void {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}-${randomHex()}`);
  try {
    writeFileSync(temp, data, { mode: 0o644 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
}

export function removeTree(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      unlinkSync(path);
    }
  } catch {}
}

export class Store {
  readonly path: string;
  readonly scriptsDir: string;
  private lockFd: number | null = null;

  constructor(readonly dataRoot: string) {
    this.path = join(dataRoot, "Scripts");
    this.scriptsDir = join(this.path, "scripts");
  }

  open(create: boolean): boolean {
    if (!existsSync(this.dataRoot)) {
      if (!create) return false;
      throw new StoreError(`${this.dataRoot} doesn't exist`);
    }
    if (!create && !existsSync(this.path)) {
      return false;
    }
    if (create) {
      mkdirSync(this.path, { recursive: true, mode: 0o700 });
      mkdirSync(this.scriptsDir, { recursive: true, mode: 0o755 });
    }
    return true;
  }

  lock(): void {
    const lockPath = join(this.path, ".lock");
    const fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
    const deadline = Date.now() + LOCK_TIMEOUT * 1000;
    while (true) {
      const ret = libSystem.symbols.flock(fd, 2 | 4); // LOCK_EX | LOCK_NB
      if (ret === 0) break;
      if (Date.now() >= deadline) {
        closeSync(fd);
        throw new StoreError(`another bay scripts command or Bay has held ${lockPath} for ${LOCK_TIMEOUT}s`);
      }
      Bun.sleepSync(50);
    }
    this.lockFd = fd;
  }

  unlock(): void {
    if (this.lockFd !== null) {
      try {
        libSystem.symbols.flock(this.lockFd, 8); // LOCK_UN
        closeSync(this.lockFd);
      } catch {}
      this.lockFd = null;
    }
  }

  close(): void {
    this.unlock();
  }

  readRecord(id: string): Record<string, unknown> | null {
    const file = join(this.scriptsDir, id, "meta.json");
    const data = readFileSafe(file);
    if (!data) return null;
    try {
      const parsed = JSON.parse(data.toString("utf8"));
      return typeof parsed === "object" && parsed !== null && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  installed(): Array<Record<string, unknown>> {
    if (!existsSync(this.scriptsDir)) return [];
    const entries = readdirSync(this.scriptsDir);
    const found: Array<Record<string, unknown>> = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = join(this.scriptsDir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new StoreError(`${full} is a symbolic link; remove it`);
      }
      if (!stat.isDirectory()) continue;
      const meta = this.readRecord(name);
      if (meta) found.push(meta);
    }
    return found.sort((a, b) => {
      const timeDiff = ((a.installed_at as number) || 0) - ((b.installed_at as number) || 0);
      if (timeDiff !== 0) return timeDiff;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  find(name: string): Record<string, unknown> | null {
    const scripts = this.installed();
    return scripts.find((m) => m.name === name) || scripts.find((m) => m.id === name) || null;
  }

  status(): Record<string, unknown> | null {
    const data = readFileSafe(join(this.path, STATUS));
    if (!data) return null;
    try {
      const parsed = JSON.parse(data.toString("utf8"));
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }

  generation(): number {
    const data = readFileSafe(join(this.path, GENERATION));
    if (!data) return 0;
    const text = data.toString("utf8").trim();
    return /^\d+$/.test(text) ? parseInt(text, 10) : 0;
  }

  extensionGeneration(): number {
    const extDir = join(this.path, EXTENSION);
    if (!existsSync(extDir)) return 0;
    const data = readFileSafe(join(extDir, GENERATION));
    if (!data) return 0;
    const text = data.toString("utf8").trim();
    return /^\d+$/.test(text) ? parseInt(text, 10) : 0;
  }

  extensionPresent(): boolean {
    return existsSync(join(this.path, EXTENSION));
  }

  nextGeneration(): number {
    const statusGen = (this.status()?.generation as number) || 0;
    return Math.max(this.generation(), this.extensionGeneration(), typeof statusGen === "number" ? statusGen : 0) + 1;
  }

  stageRecord(build: Build): [string, Record<string, unknown>] {
    const meta = build.meta;
    const previous = this.readRecord(meta.id);
    const now = Date.now() / 1000;
    const suffix = SOURCE_SUFFIXES.find((s) => build.path.endsWith(s)) || ".js";
    const record: Record<string, unknown> = {
      name: meta.name,
      namespace: meta.namespace,
      version: meta.version,
      description: meta.description,
      matches: meta.matches,
      exclude_matches: meta.exclude_matches,
      includes: meta.includes,
      excludes: meta.excludes,
      run_at: meta.run_at,
      inject_into: meta.inject_into,
      noframes: meta.noframes,
      warnings: meta.warnings,
      id: meta.id,
      world: meta.world,
      source_file: build.path,
      source: `source${suffix}`,
      installed_at: previous ? previous.installed_at : now,
      updated_at: now,
      updated: previous !== null,
    };

    const stageName = `.stage-${meta.id}-${randomHex()}`;
    const stagePath = join(this.scriptsDir, stageName);
    mkdirSync(stagePath, { recursive: true, mode: 0o755 });
    try {
      writeFileSync(join(stagePath, record.source as string), build.source, "utf8");
      writeFileSync(join(stagePath, "script.js"), build.js, "utf8");
      writeFileSync(join(stagePath, "meta.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
    } catch (error) {
      removeTree(stagePath);
      throw error;
    }
    return [stageName, record];
  }

  buildExtension(records: Array<[Record<string, unknown>, string]>, generation: number): string {
    const stageName = `.extension-${randomHex()}`;
    const stagePath = join(this.path, stageName);
    mkdirSync(join(stagePath, "js"), { recursive: true, mode: 0o755 });

    try {
      const entries: Array<Record<string, unknown>> = [];
      const jsFiles = new Set<string>();

      for (const [meta, folder] of records) {
        const id = meta.id as string;
        const scriptData = readFileSafe(join(this.scriptsDir, folder, "script.js"));
        if (!scriptData) {
          throw new StoreError(`${id} has no script.js; reinstall it`);
        }
        writeFileSync(join(stagePath, "js", `${id}.js`), scriptData);
        jsFiles.add(`js/${id}.js`);
        entries.push(...manifestEntries(metaFromRecord(meta), `js/${id}.js`));
      }

      const manifest = {
        manifest_version: 3,
        name: EXTENSION_NAME,
        version: manifestVersion(generation),
        description: EXTENSION_DESCRIPTION,
        content_scripts: entries,
      };

      validateManifest(manifest, jsFiles);
      const manifestText = JSON.stringify(manifest, null, 2) + "\n";
      if (Buffer.byteLength(manifestText) > MAX_MANIFEST) {
        throw new StoreError(
          `the generated manifest would be ${Buffer.byteLength(manifestText)} bytes, over the ${MAX_MANIFEST} limit; uninstall some scripts`,
        );
      }
      writeFileSync(join(stagePath, "manifest.json"), manifestText, "utf8");
      writeFileSync(join(stagePath, GENERATION), `${generation}\n`, "utf8");
    } catch (error) {
      removeTree(stagePath);
      throw error;
    }

    return stageName;
  }

  publishExtension(staged: string | null): string | null {
    const extPath = join(this.path, EXTENSION);
    const present = existsSync(extPath);
    if (present) {
      const stat = lstatSync(extPath);
      if (!stat.isDirectory()) {
        throw new StoreError(`${extPath} isn't a folder the bay command made; move it away first`);
      }
    }
    if (staged === null) {
      if (!present) return null;
      const oldName = `.extension-old-${randomHex()}`;
      renameSync(extPath, join(this.path, oldName));
      return oldName;
    }
    const stagedPath = join(this.path, staged);
    if (present) {
      swap(stagedPath, extPath);
      return staged;
    }
    renameSync(stagedPath, extPath);
    return null;
  }

  restoreExtension(staged: string | null, old: string | null): void {
    const extPath = join(this.path, EXTENSION);
    if (old !== null && staged !== null && old === staged) {
      swap(join(this.path, staged), extPath);
    } else if (old !== null) {
      renameSync(join(this.path, old), extPath);
    } else if (staged !== null && existsSync(extPath)) {
      removeTree(extPath);
    }
  }

  apply(options: { add?: Build; remove?: string } = {}): [Record<string, unknown>, number] {
    const current = this.installed();
    const generation = this.nextGeneration();
    let stagedRecord: string | null = null;
    let record: Record<string, unknown> | null = null;

    let plan: Array<[Record<string, unknown>, string]>;
    if (options.add) {
      const [stageName, rec] = this.stageRecord(options.add);
      stagedRecord = stageName;
      record = rec;
      const kept: Array<[Record<string, unknown>, string]> = current.filter((m) => m.id !== record!.id).map((m) => [m, m.id as string]);
      const addedEntry: [Record<string, unknown>, string] = [record!, stagedRecord!];
      plan = [...kept, addedEntry].sort((a, b) => {
        const aTime = (a[0]["installed_at"] as number) || 0;
        const bTime = (b[0]["installed_at"] as number) || 0;
        return aTime - bTime;
      });
    } else if (options.remove) {
      record = current.find((m) => m.id === options.remove) || null;
      if (!record) throw new StoreError(`no installed script has id ${options.remove}`);
      plan = current.filter((m) => m.id !== options.remove).map((m) => [m, m.id as string]);
    } else {
      record = null;
      plan = current.map((m) => [m, m.id as string]);
    }

    let stagedExtension: string | null = null;
    let oldExtension: string | null = null;
    let published = false;

    try {
      stagedExtension = plan.length ? this.buildExtension(plan, generation) : null;
      if (!plan.length && this.extensionPresent()) {
        writeAtomic(join(this.path, GENERATION), `${generation}\n`);
      }
      oldExtension = this.publishExtension(stagedExtension);
      published = true;
      if (record !== null) {
        this.commitRecord(stagedRecord, record.id as string, options.add === undefined);
      }
    } catch (error) {
      if (published) {
        try {
          this.restoreExtension(stagedExtension, oldExtension);
        } catch {}
      }
      if (stagedRecord) removeTree(join(this.scriptsDir, stagedRecord));
      if (stagedExtension) removeTree(join(this.path, stagedExtension));
      throw error;
    }

    for (const leftover of [oldExtension, stagedExtension]) {
      if (leftover && existsSync(join(this.path, leftover))) {
        removeTree(join(this.path, leftover));
      }
    }

    writeAtomic(join(this.path, GENERATION), `${generation}\n`);
    return [record ?? {}, generation];
  }

  commitRecord(staged: string | null, recordId: string, removing: boolean): void {
    const targetPath = join(this.scriptsDir, recordId);
    if (removing) {
      const trash = join(this.scriptsDir, `.old-${recordId}-${randomHex()}`);
      if (existsSync(targetPath)) {
        renameSync(targetPath, trash);
        removeTree(trash);
      }
      return;
    }
    const stagedPath = join(this.scriptsDir, staged!);
    if (existsSync(targetPath)) {
      const stat = lstatSync(targetPath);
      if (!stat.isDirectory()) {
        throw new StoreError(`${targetPath} isn't a folder the bay command made`);
      }
      swap(stagedPath, targetPath);
      removeTree(stagedPath);
    } else {
      renameSync(stagedPath, targetPath);
    }
  }

  expectedManifest(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const entries: Array<Record<string, unknown>> = [];
    for (const meta of records) {
      entries.push(...manifestEntries(metaFromRecord(meta), `js/${meta.id}.js`));
    }
    return entries;
  }

  consistent(records: Array<Record<string, unknown>>): boolean {
    if (!records.length) return !this.extensionPresent();
    if (!this.extensionPresent()) return false;
    const extDir = join(this.path, EXTENSION);
    try {
      const manifestData = readFileSafe(join(extDir, "manifest.json"));
      if (!manifestData) return false;
      const manifest = JSON.parse(manifestData.toString("utf8"));
      if (typeof manifest !== "object" || manifest === null || JSON.stringify(manifest.content_scripts) !== JSON.stringify(this.expectedManifest(records))) {
        return false;
      }
      const jsDir = join(extDir, "js");
      if (!existsSync(jsDir)) return false;
      const files = readdirSync(jsDir).sort();
      const expectedFiles = records.map((m) => `${m.id}.js`).sort();
      if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) return false;

      for (const meta of records) {
        const id = meta.id as string;
        const recordJs = readFileSafe(join(this.scriptsDir, id, "script.js"));
        const extJs = readFileSafe(join(jsDir, `${id}.js`));
        if (!recordJs || !extJs || !recordJs.equals(extJs)) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  repair(): string | null {
    const records = this.installed();
    if (!this.consistent(records)) {
      const [, generation] = this.apply();
      return `the installed scripts and the extension disagreed; rebuilt it as generation ${generation}`;
    }
    const current = this.generation();
    if (this.extensionPresent()) {
      const published = this.extensionGeneration();
      if (published > current) {
        writeAtomic(join(this.path, GENERATION), `${published}\n`);
        return `a run stopped before publishing generation ${published}; published it`;
      }
      if (published < current) {
        const [, generation] = this.apply();
        return `the extension was older than generation ${current}; rebuilt it as generation ${generation}`;
      }
      return null;
    }
    const status = this.status() || {};
    const reported = status.generation;
    const profiles = (status.profiles as Record<string, unknown>) || {};
    const stillLoaded = Object.values(profiles).some((r) => typeof r === "object" && r !== null && (r as { ok?: unknown }).ok);
    if (typeof reported === "number" && reported >= current && stillLoaded) {
      const [, generation] = this.apply();
      return `the last uninstall stopped before telling Bay; published generation ${generation}`;
    }
    return null;
  }

  waitStatus(generation: number, alive: () => boolean): [string, Record<string, unknown> | null] {
    const deadline = Date.now() + STATUS_TIMEOUT * 1000;
    while (true) {
      const status = this.status();
      const reported = status?.generation;
      if (typeof reported === "number" && reported >= generation) {
        return [reported > generation ? "superseded" : "reported", status];
      }
      if (!alive()) {
        return ["quit", null];
      }
      if (Date.now() >= deadline) {
        return ["timeout", null];
      }
      Bun.sleepSync(STATUS_POLL);
    }
  }
}

export function metaFromRecord(record: Record<string, unknown>): Meta {
  return {
    name: String(record.name || ""),
    namespace: String(record.namespace || ""),
    version: String(record.version || ""),
    description: String(record.description || ""),
    matches: Array.isArray(record.matches) ? (record.matches as string[]) : [],
    exclude_matches: Array.isArray(record.exclude_matches) ? (record.exclude_matches as string[]) : [],
    includes: Array.isArray(record.includes) ? (record.includes as string[]) : [],
    excludes: Array.isArray(record.excludes) ? (record.excludes as string[]) : [],
    run_at: (record.run_at as Meta["run_at"]) || "document-end",
    inject_into: (record.inject_into as Meta["inject_into"]) || "page",
    noframes: Boolean(record.noframes),
    warnings: Array.isArray(record.warnings) ? (record.warnings as string[]) : [],
    id: String(record.id || ""),
    world: (record.world as "MAIN" | "ISOLATED") || "MAIN",
  };
}

export function manifestVersion(generation: number): string {
  return `1.${Math.floor(generation / 65536) % 65536}.${generation % 65536}`;
}

export function validateManifest(manifest: Record<string, unknown>, jsFiles: Set<string>): void {
  function fail(message: string): never {
    throw new StoreError(`the generated manifest is invalid (${message}); nothing was changed`);
  }

  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) fail("unexpected keys");
  }
  if (manifest.manifest_version !== 3) fail("manifest_version must be 3");

  for (const key of ["name", "version", "description"]) {
    if (typeof manifest[key] !== "string" || !manifest[key]) {
      fail("name, version and description must be text");
    }
  }

  const entries = manifest.content_scripts;
  if (!Array.isArray(entries) || !entries.length) fail("no content scripts");
  if (entries.length > MAX_ENTRIES) {
    fail(`${entries.length} content script entries, over Bay's limit of ${MAX_ENTRIES}; uninstall some scripts`);
  }

  const files = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === "object" && entry !== null && Array.isArray((entry as { js?: unknown }).js)) {
      for (const js of (entry as { js: unknown[] }).js) {
        if (typeof js === "string") files.add(js);
      }
    }
  }
  if (files.size > MAX_FILES) {
    fail(`${files.size} script files, over Bay's limit of ${MAX_FILES}; uninstall some scripts`);
  }

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) fail("a content script has unexpected keys");
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) fail("a content script has unexpected keys");
    }
    const e = entry as Record<string, unknown>;
    try {
      if (!Array.isArray(e.matches) || !e.matches.length) fail("a content script has no matches");
      for (const key of ["matches", "exclude_matches"] as const) {
        if (e[key] !== undefined) {
          if (!Array.isArray(e[key])) fail(`${key} isn't a list`);
          for (const pattern of e[key] as string[]) checkMatch(pattern, key);
        }
      }
      for (const key of ["include_globs", "exclude_globs"] as const) {
        if (e[key] !== undefined) {
          if (!Array.isArray(e[key])) fail(`${key} isn't a list`);
          for (const glob of e[key] as string[]) checkGlob(glob, key);
        }
      }
    } catch (error) {
      if (error instanceof StoreError) throw error;
      fail(error instanceof Error ? error.message : String(error));
    }
    if (!Array.isArray(e.js) || !e.js.length || e.js.length > MAX_FILES_PER_ENTRY || (e.js as string[]).some((js) => !jsFiles.has(js))) {
      fail("a content script names a file that isn't there");
    }
    if (typeof e.run_at !== "string" || !RUN_AT.has(e.run_at) || typeof e.world !== "string" || !WORLDS.has(e.world) || typeof e.all_frames !== "boolean") {
      fail("bad run_at, world or all_frames");
    }
  }
}

export function repairIfPresent(dataRoot: string): string | null {
  const store = new Store(dataRoot);
  try {
    if (!store.open(false) || (!existsSync(store.scriptsDir) && !store.extensionPresent() && !store.generation())) {
      return null;
    }
    store.lock();
    if (!existsSync(store.scriptsDir)) {
      mkdirSync(store.scriptsDir, { recursive: true, mode: 0o755 });
    }
    return store.repair();
  } finally {
    store.close();
  }
}
