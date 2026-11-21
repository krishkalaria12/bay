import { dlopen, FFIType } from "bun:ffi";
import { sleepSync } from "bun";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as v from "valibot";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
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

export interface ScriptRecord {
  [key: string]: ScriptRecordValue | undefined;
}

export type ScriptRecordValue = string | number | boolean | string[];

const ScriptValueSchema = v.union([v.string(), v.number(), v.boolean(), v.array(v.string())]);
const ScriptRecordSchema = v.record(v.string(), ScriptValueSchema);

const ManifestSchema = v.object({
  content_scripts: v.optional(v.array(ScriptRecordSchema)),
});

const StatusSchema = v.object({
  generation: v.optional(v.number()),
  profiles: v.optional(v.record(v.string(), v.object({ ok: v.optional(v.boolean()) }))),
});

const RunAtSchema = v.picklist(["document-start", "document-end", "document-idle"]);
const InjectIntoSchema = v.picklist(["page", "auto", "content"]);
const WorldSchema = v.picklist(["MAIN", "ISOLATED"]);

export type StatusRecord = v.InferOutput<typeof StatusSchema>;

interface GeneratedManifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  description?: string;
  content_scripts?: Array<ScriptRecord>;
}

export const LOCK_TIMEOUT = 30;
export const STATUS_TIMEOUT = 10;
export const STATUS_POLL = 100;
export const LOCK_POLL = 50;
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

// Loaded only when a scripts command needs it. Ordinary CLI commands never
// try to load a library from another operating system.
function openPosix() {
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}

let posix: ReturnType<typeof openPosix> | undefined;
const posixLibrary = () => (posix ??= openPosix());

function openExchange() {
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      renameatx_np: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
        returns: FFIType.i32,
      },
    });

    return (first: Buffer, second: Buffer) => library.symbols.renameatx_np(AT_FDCWD, first, AT_FDCWD, second, RENAME_SWAP);
  }

  const library = dlopen("libc.so.6", {
    renameat2: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
      returns: FFIType.i32,
    },
  });

  return (first: Buffer, second: Buffer) => library.symbols.renameat2(-100, first, -100, second, 2); // AT_FDCWD, RENAME_EXCHANGE
}

let exchange: ReturnType<typeof openExchange> | undefined;

function openWindows() {
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64],
      returns: FFIType.u64,
    },
    GetFileInformationByHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    LockFileEx: {
      args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    UnlockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
}

let windows: ReturnType<typeof openWindows> | undefined;

export class StoreError extends Error {
  override name = "StoreError";
}

// apply() must not delete staged files when an OS move could not be undone.
class SwapRecoveryError extends StoreError {}

function randomHex(bytes = 6): string {
  return randomBytes(bytes).toString("hex");
}

// The caller holds the store's lock. Windows has no directory exchange; keep
// readers behind that lock until all three same-volume moves have finished.
export function swap(first: string, second: string): void {
  if (process.platform === "win32") {
    if (dirname(first) !== dirname(second)) throw new StoreError("directory exchanges must stay in one folder");
    const temporary = join(dirname(second), `.swap-${randomHex()}`);
    const journal = `${temporary}.json`;
    writeFileSync(journal, JSON.stringify({ first: basename(first), second: basename(second) }), { flag: "wx", mode: 0o600 });
    renameSync(second, temporary);

    try {
      renameSync(first, second);
    } catch (error) {
      try {
        renameSync(temporary, second);
        removeTree(journal);
      } catch (restoreError) {
        throw new SwapRecoveryError(`can't restore ${second}; its previous contents remain in ${temporary}: ${String(restoreError)}`);
      }

      throw error;
    }

    try {
      renameSync(temporary, first);
    } catch (error) {
      // Restore both names before letting apply() remove its staged copy.
      // If restoration also fails, preserve every surviving directory.
      try {
        renameSync(second, first);
        renameSync(temporary, second);
        removeTree(journal);
      } catch (restoreError) {
        throw new SwapRecoveryError(`can't restore exchanged folders; preserve ${first}, ${second} and ${temporary}: ${String(restoreError)}`);
      }

      throw error;
    }

    removeTree(journal);

    return;
  }

  const ret = (exchange ??= openExchange())(Buffer.from(`${first}\0`), Buffer.from(`${second}\0`));

  if (ret !== 0) {
    throw new StoreError(`can't swap ${first} and ${second}`);
  }
}

// Recover a process that stopped between Windows' directory moves. The old
// copy goes back if publication never happened; otherwise finish the exchange.
// Only names from a bounded plain journal in this folder can be recovered.
function recoverSwaps(directory: string): void {
  if (!existsSync(directory)) return;

  for (const name of readdirSync(directory)) {
    if (!/^\.swap-[a-f0-9]{12}\.json$/.test(name)) continue;
    const journal = join(directory, name);
    const stat = lstatSync(journal);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) {
      throw new StoreError(`can't recover ${journal}: not a plain journal`);
    }

    const record: unknown = JSON.parse(readFileSync(journal, "utf8"));

    const safeName = (value: unknown): value is string =>
      v.is(v.string(), value) && value.length > 0 && value !== "." && value !== ".." && !/[\\/\0:]/.test(value);

    if (!v.is(v.object({}), record)) throw new StoreError(`can't recover ${journal}: invalid folder names`);

    // SAFETY: the check above established that the record is an object with named fields.
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- The record's fields are read by name, and each is checked where it is used.
    const fields = record as Record<string, unknown>;

    if (!("first" in fields) || !("second" in fields) || !safeName(fields.first) || !safeName(fields.second)) {
      throw new StoreError(`can't recover ${journal}: invalid folder names`);
    }

    const temporaryName = name.slice(0, -5);

    if (fields.first === fields.second || fields.first === temporaryName || fields.second === temporaryName) {
      throw new StoreError(`can't recover ${journal}: overlapping folder names`);
    }

    const first = join(directory, fields.first);
    const second = join(directory, fields.second);
    const temporary = join(directory, temporaryName);

    const present = (path: string): boolean => {
      if (!existsSync(path)) return false;
      const info = lstatSync(path);

      if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreError(`can't recover ${journal}: ${path} isn't a plain folder`);

      return true;
    };

    const hasFirst = present(first);
    const hasSecond = present(second);
    const hasTemporary = present(temporary);

    if (hasTemporary && hasFirst && !hasSecond) renameSync(temporary, second);
    else if (hasTemporary && !hasFirst && hasSecond) renameSync(temporary, first);
    else if (hasTemporary || !hasSecond) throw new StoreError(`can't recover ${journal}; its folders were preserved`);
    unlinkSync(journal);
  }
}

/**
 * Takes the lock file's lock without waiting: the way to give it back when it was free, nothing when it was not.
 *
 * The lock file must be a plain file. A symbolic link would let another folder take the lock's place, and a hard
 * link would let a second name lock the same file, so both are refused.
 */
function acquireLock(path: string): (() => void) | null {
  if (process.platform === "win32") {
    const { symbols } = (windows ??= openWindows());
    // Share reads and writes, but not deletion: every reader locks the same
    // file object. Never follow a reparse point, including a junction.
    const handle = symbols.CreateFileW(Buffer.from(`${path}\0`, "utf16le"), 0xc0000000, 3, null, 4, 0x00200000, 0n);

    if (handle === 0xffffffffffffffffn) throw new StoreError(`can't open ${path} (Windows error ${symbols.GetLastError()})`);
    const info = new Uint32Array(13);
    const overlapped = new BigUint64Array(4); // 64-bit OVERLAPPED, offset zero.
    let locked = false;

    try {
      if (!symbols.GetFileInformationByHandle(handle, info) || (info[0]! & 0x410) !== 0 || info[10] !== 1) {
        throw new StoreError(`${path} must be a plain file without links`);
      }

      // LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY: the lock is taken or the handle is busy.
      if (!symbols.LockFileEx(handle, 3, 0, 1, 0, overlapped)) {
        const error = symbols.GetLastError();

        if (error !== 33) throw new StoreError(`can't lock ${path} (Windows error ${error})`);

        return null;
      }

      locked = true;
    } finally {
      if (!locked) symbols.CloseHandle(handle);
    }

    return () => {
      symbols.UnlockFileEx(handle, 0, 1, 0, overlapped);
      symbols.CloseHandle(handle);
    };
  }

  const { symbols } = posixLibrary();
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    // SAFETY: the only errors reaching here come from node:fs calls, which carry an ErrnoException code.
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new StoreError(`${path} is a symbolic link`);

    throw error;
  }

  let locked = false;

  try {
    const info = fstatSync(fd);

    if (!info.isFile() || info.nlink !== 1) throw new StoreError(`${path} must be a plain file without links`);

    // LOCK_EX | LOCK_NB
    if (symbols.flock(fd, 2 | 4) !== 0) return null;

    locked = true;
  } finally {
    if (!locked) closeSync(fd);
  }

  return () => {
    try {
      symbols.flock(fd, 8); // LOCK_UN
    } finally {
      closeSync(fd);
    }
  };
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
    // SAFETY: the only errors reaching here come from node:fs calls, which carry an ErrnoException code.
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
  private releaseLock: (() => void) | null = null;

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

    for (const directory of [this.path, this.scriptsDir]) {
      if (existsSync(directory)) {
        const info = lstatSync(directory);

        if (info.isSymbolicLink() || !info.isDirectory()) throw new StoreError(`${directory} must be a plain folder`);
      } else if (create) {
        mkdirSync(directory, { recursive: true, mode: directory === this.path ? 0o700 : 0o755 });
      }
    }

    return true;
  }

  /**
   * Takes the store's lock if it is free, and says whether it did. The waiting is lock()'s and lockStore's.
   *
   * Holding the lock also finishes an exchange that a crashed run left half-done, so every holder of the lock sees
   * the same folders.
   */
  tryLock(): boolean {
    if (this.releaseLock) return true;

    const release = acquireLock(this.lockPath);

    if (!release) return false;

    this.releaseLock = release;

    try {
      recoverSwaps(this.path);
      recoverSwaps(this.scriptsDir);
    } catch (error) {
      this.unlock();
      throw error;
    }

    return true;
  }

  /**
   * Takes the store's lock, waiting for it until it is free.
   *
   * The caller holds the lock until it unlocks. Windows has no directory exchange, so the lock is the only way to
   * keep two processes out of the same store.
   */
  lock(): void {
    if (this.releaseLock) throw new StoreError("this scripts store is already locked");

    while (!this.tryLock()) {
      // The lock is held elsewhere: wait a little and try again.
      sleepSync(LOCK_POLL);
    }
  }

  /** Where the lock is. */
  get lockPath(): string {
    return join(this.path, ".lock");
  }

  unlock(): void {
    const release = this.releaseLock;
    this.releaseLock = null;
    release?.();
  }

  close(): void {
    this.unlock();
  }

  readRecord(id: string): ScriptRecord | null {
    const file = join(this.scriptsDir, id, "meta.json");
    const data = readFileSafe(file);

    if (!data) return null;

    try {
      const parsed = v.safeParse(ScriptRecordSchema, JSON.parse(data.toString("utf8")));

      if (!parsed.success) return null;

      return parsed.output.id === id ? parsed.output : null;
    } catch {
      return null;
    }
  }

  installed(): Array<ScriptRecord> {
    if (!existsSync(this.scriptsDir)) return [];
    const entries = readdirSync(this.scriptsDir);
    const found: Array<ScriptRecord> = [];

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
      const timeDiff = (Number(a.installed_at) || 0) - (Number(b.installed_at) || 0);

      if (timeDiff !== 0) return timeDiff;

      return String(a.id).localeCompare(String(b.id));
    });
  }

  find(name: string): ScriptRecord | null {
    const scripts = this.installed();

    return scripts.find((m) => m.name === name) || scripts.find((m) => m.id === name) || null;
  }

  status(): StatusRecord | null {
    const data = readFileSafe(join(this.path, STATUS));

    if (!data) return null;

    try {
      const parsed = v.safeParse(StatusSchema, JSON.parse(data.toString("utf8")));

      return parsed.success ? parsed.output : null;
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
    const statusGen = this.status()?.generation ?? 0;

    return Math.max(this.generation(), this.extensionGeneration(), statusGen) + 1;
  }

  stageRecord(build: Build): [string, ScriptRecord] {
    const meta = build.meta;
    const previous = this.readRecord(meta.id);
    const now = Date.now() / 1000;
    const suffix = SOURCE_SUFFIXES.find((s) => build.path.endsWith(s)) || ".js";
    const sourceName = `source${suffix}`;

    const record = {
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
      source: sourceName,
      installed_at: previous ? previous.installed_at : now,
      updated_at: now,
      updated: previous !== null,
    } satisfies ScriptRecord;

    const stageName = `.stage-${meta.id}-${randomHex()}`;
    const stagePath = join(this.scriptsDir, stageName);
    mkdirSync(stagePath, { recursive: true, mode: 0o755 });

    try {
      writeFileSync(join(stagePath, sourceName), build.source, "utf8");
      writeFileSync(join(stagePath, "script.js"), build.js, "utf8");
      writeFileSync(join(stagePath, "meta.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
    } catch (error) {
      removeTree(stagePath);
      throw error;
    }

    return [stageName, record];
  }

  buildExtension(records: Array<[ScriptRecord, string]>, generation: number): string {
    const stageName = `.extension-${randomHex()}`;
    const stagePath = join(this.path, stageName);
    mkdirSync(join(stagePath, "js"), { recursive: true, mode: 0o755 });

    try {
      const entries: Array<ScriptRecord> = [];
      const jsFiles = new Set<string>();

      for (const [meta, folder] of records) {
        const id = String(meta.id ?? "");
        const scriptData = readFileSafe(join(this.scriptsDir, folder, "script.js"));

        if (!scriptData) {
          throw new StoreError(`${id} has no script.js; reinstall it`);
        }

        writeFileSync(join(stagePath, "js", `${id}.js`), scriptData);
        jsFiles.add(`js/${id}.js`);
        // SAFETY: manifestEntries only emits flat records of string[]/string/boolean values (see userscript.ts), exactly ScriptRecord's value union.
        entries.push(...(manifestEntries(metaFromRecord(meta), `js/${id}.js`) as ScriptRecord[]));
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

  apply(options: { add?: Build; remove?: string } = {}): [ScriptRecord, number] {
    const current = this.installed();
    const generation = this.nextGeneration();
    let stagedRecord: string | null = null;
    let record: ScriptRecord | null = null;

    let plan: Array<[ScriptRecord, string]>;

    if (options.add) {
      const [stageName, rec] = this.stageRecord(options.add);
      stagedRecord = stageName;
      record = rec;

      const kept: Array<[ScriptRecord, string]> = current.filter((m) => m.id !== rec.id).map((m): [ScriptRecord, string] => [m, String(m.id ?? "")]);

      const addedEntry: [ScriptRecord, string] = [rec, stageName];
      plan = [...kept, addedEntry].sort((a, b) => {
        const aTime = Number(a[0]["installed_at"]) || 0;
        const bTime = Number(b[0]["installed_at"]) || 0;

        return aTime - bTime;
      });
    } else if (options.remove) {
      record = current.find((m) => m.id === options.remove) || null;

      if (!record) throw new StoreError(`no installed script has id ${options.remove}`);
      plan = current.filter((m) => m.id !== options.remove).map((m): [ScriptRecord, string] => [m, String(m.id ?? "")]);
    } else {
      record = null;
      plan = current.map((m): [ScriptRecord, string] => [m, String(m.id ?? "")]);
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
        this.commitRecord(stagedRecord, String(record.id ?? ""), options.add === undefined);
      }
    } catch (error) {
      if (error instanceof SwapRecoveryError) throw error;

      if (published) {
        try {
          this.restoreExtension(stagedExtension, oldExtension);
        } catch (restoreError) {
          throw new StoreError(`couldn't restore the previous extension; staged folders were preserved: ${String(restoreError)}`);
        }
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

  expectedManifest(records: Array<ScriptRecord>): Array<ScriptRecord> {
    const entries: Array<ScriptRecord> = [];

    for (const meta of records) {
      // SAFETY: manifestEntries only emits flat records of string[]/string/boolean values (see userscript.ts), exactly ScriptRecord's value union.
      entries.push(...(manifestEntries(metaFromRecord(meta), `js/${String(meta.id ?? "")}.js`) as ScriptRecord[]));
    }

    return entries;
  }

  consistent(records: Array<ScriptRecord>): boolean {
    if (!records.length) return !this.extensionPresent();

    if (!this.extensionPresent()) return false;
    const extDir = join(this.path, EXTENSION);

    try {
      const manifestData = readFileSafe(join(extDir, "manifest.json"));

      if (!manifestData) return false;
      const parsedManifest = v.safeParse(ManifestSchema, JSON.parse(manifestData.toString("utf8")));

      if (!parsedManifest.success || JSON.stringify(parsedManifest.output.content_scripts) !== JSON.stringify(this.expectedManifest(records))) {
        return false;
      }

      const jsDir = join(extDir, "js");

      if (!existsSync(jsDir)) return false;
      const files = readdirSync(jsDir).sort();
      const expectedFiles = records.map((m) => `${m.id}.js`).sort();

      if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) return false;

      for (const meta of records) {
        const id = String(meta.id ?? "");
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

    const status = this.status();
    const reported = status?.generation;
    const profiles = status?.profiles ?? {};
    const stillLoaded = Object.values(profiles).some((r) => r.ok);

    if (reported !== undefined && reported >= current && stillLoaded) {
      const [, generation] = this.apply();

      return `the last uninstall stopped before telling Bay; published generation ${generation}`;
    }

    return null;
  }
}

export function metaFromRecord(record: ScriptRecord): Meta {
  return {
    name: String(record.name || ""),
    namespace: String(record.namespace || ""),
    version: String(record.version || ""),
    description: String(record.description || ""),
    matches: Array.isArray(record.matches) ? record.matches : [],
    exclude_matches: Array.isArray(record.exclude_matches) ? record.exclude_matches : [],
    includes: Array.isArray(record.includes) ? record.includes : [],
    excludes: Array.isArray(record.excludes) ? record.excludes : [],
    run_at: v.is(RunAtSchema, record.run_at) ? record.run_at : "document-end",
    inject_into: v.is(InjectIntoSchema, record.inject_into) ? record.inject_into : "page",
    noframes: Boolean(record.noframes),
    warnings: Array.isArray(record.warnings) ? record.warnings : [],
    id: String(record.id || ""),
    world: v.is(WorldSchema, record.world) ? record.world : "MAIN",
  };
}

export function manifestVersion(generation: number): string {
  return `1.${Math.floor(generation / 65536) % 65536}.${generation % 65536}`;
}

export function validateManifest(manifest: GeneratedManifest, jsFiles: Set<string>): void {
  function fail(message: string): never {
    throw new StoreError(`the generated manifest is invalid (${message}); nothing was changed`);
  }

  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) fail("unexpected keys");
  }

  if (manifest.manifest_version !== 3) fail("manifest_version must be 3");

  for (const key of ["name", "version", "description"] as const) {
    const value = manifest[key];

    if (!v.is(v.string(), value) || !value) {
      fail("name, version and description must be text");
    }
  }

  const parsedEntries = v.safeParse(v.array(ScriptRecordSchema), manifest.content_scripts);

  if (!parsedEntries.success || !parsedEntries.output.length) fail("no content scripts");

  if (parsedEntries.output.length > MAX_ENTRIES) {
    fail(`${parsedEntries.output.length} content script entries, over Bay's limit of ${MAX_ENTRIES}; uninstall some scripts`);
  }

  const entries = parsedEntries.output;

  const files = new Set<string>();

  for (const entry of entries) {
    const jsList = entry.js;

    if (Array.isArray(jsList)) {
      for (const js of jsList) {
        files.add(js);
      }
    }
  }

  if (files.size > MAX_FILES) {
    fail(`${files.size} script files, over Bay's limit of ${MAX_FILES}; uninstall some scripts`);
  }

  for (const entry of entries) {
    if (Array.isArray(entry)) fail("a content script has unexpected keys");

    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) fail("a content script has unexpected keys");
    }

    const e = entry;

    try {
      if (!Array.isArray(e.matches) || !e.matches.length) fail("a content script has no matches");

      for (const key of ["matches", "exclude_matches"] as const) {
        const list = e[key];

        if (list !== undefined) {
          if (!Array.isArray(list)) fail(`${key} isn't a list`);

          for (const pattern of list) {
            checkMatch(pattern, key);
          }
        }
      }

      for (const key of ["include_globs", "exclude_globs"] as const) {
        const list = e[key];

        if (list !== undefined) {
          if (!Array.isArray(list)) fail(`${key} isn't a list`);

          for (const glob of list) {
            checkGlob(glob, key);
          }
        }
      }
    } catch (error) {
      if (error instanceof StoreError) throw error;
      fail(error instanceof Error ? error.message : String(error));
    }

    if (!Array.isArray(e.js) || !e.js.length || e.js.length > MAX_FILES_PER_ENTRY || !e.js.every((js) => jsFiles.has(js))) {
      fail("a content script names a file that isn't there");
    }

    if (!v.is(v.string(), e.run_at) || !RUN_AT.has(e.run_at) || !v.is(v.string(), e.world) || !WORLDS.has(e.world) || !v.is(v.boolean(), e.all_frames)) {
      fail("bad run_at, world or all_frames");
    }
  }
}

/** Repairs an interrupted change, when there is a store to repair: what it did, or nothing. Holds the lock while it does. */
export const repairIfPresent = (dataRoot: string): Effect.Effect<string | null, StoreError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openStore(dataRoot, false);

      if (!store || (!existsSync(store.scriptsDir) && !store.extensionPresent() && !store.generation())) return null;

      yield* lockStore(store);

      if (!existsSync(store.scriptsDir)) mkdirSync(store.scriptsDir, { recursive: true, mode: 0o755 });

      return yield* attempt(() => store.repair());
    }),
  );

// MARK: The store's lifetime

/** A store step that threw: its failure, as the store's. */
const attempt = <A>(run: () => A): Effect.Effect<A, StoreError> =>
  Effect.try({ try: run, catch: (error) => (error instanceof StoreError ? error : new StoreError(error instanceof Error ? error.message : String(error))) });

/** Opens the store for the scope: nothing when it isn't there and `create` is off. Its lock goes when the scope closes. */
export const openStore = (dataRoot: string, create: boolean): Effect.Effect<Store | null, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    attempt(() => {
      const store = new Store(dataRoot);

      return store.open(create) ? store : null;
    }),
    (store) => Effect.sync(() => store?.close()),
  );

/**
 * Takes the store's lock for the scope, waiting for another bay command or Bay to let go of it, for up to
 * LOCK_TIMEOUT seconds. The lock is given back when the scope closes.
 */
export const lockStore = (store: Store): Effect.Effect<void, StoreError, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const deadline = Date.now() + LOCK_TIMEOUT * 1000;

      while (!(yield* attempt(() => store.tryLock()))) {
        if (Date.now() >= deadline)
          return yield* Effect.fail(new StoreError(`another bay scripts command or Bay has held ${store.lockPath} for ${LOCK_TIMEOUT}s`));

        yield* restore(Effect.sleep(Duration.millis(LOCK_POLL)));
      }

      yield* Effect.addFinalizer(() => Effect.sync(() => store.unlock()));
    }),
  );

/** How a wait for Bay's report ended. */
export type StatusOutcome = "reported" | "superseded" | "quit" | "timeout";

/**
 * Waits up to STATUS_TIMEOUT seconds for Bay to report `generation`: a newer report supersedes it, and Bay quitting
 * (`alive` turning false) ends the wait.
 */
export const waitForStatus = (store: Store, generation: number, alive: () => boolean): Effect.Effect<[StatusOutcome, StatusRecord | null], StoreError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + STATUS_TIMEOUT * 1000;

    for (;;) {
      const status = yield* attempt(() => store.status());
      const reported = status?.generation;

      if (reported !== undefined && reported >= generation) return [reported > generation ? "superseded" : "reported", status] as const;

      if (!alive()) return ["quit", null] as const;

      if (Date.now() >= deadline) return ["timeout", null] as const;

      yield* Effect.sleep(Duration.millis(STATUS_POLL));
    }
  }).pipe(Effect.map(([outcome, status]): [StatusOutcome, StatusRecord | null] => [outcome, status]));
