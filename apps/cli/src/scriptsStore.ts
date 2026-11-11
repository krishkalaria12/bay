import { dlopen, FFIType } from "bun:ffi";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as v from "valibot";
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

  /** Takes the store's lock if it is free, and says whether it did. The waiting is lockStore's. */
  tryLock(): boolean {
    if (this.lockFd !== null) return true;

    const fd = openSync(join(this.path, ".lock"), constants.O_RDWR | constants.O_CREAT, 0o600);

    if (libSystem.symbols.flock(fd, 2 | 4) === 0) {
      // LOCK_EX | LOCK_NB
      this.lockFd = fd;

      return true;
    }

    closeSync(fd);

    return false;
  }

  /** Where the lock is. */
  get lockPath(): string {
    return join(this.path, ".lock");
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
