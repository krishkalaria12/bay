import { realpathSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { INSTALLED_DATA_DIR } from "./endpoint.ts";
import * as urlmatch from "./urlmatch.ts";

export const RUN_AT = ["document-start", "document-end", "document-idle"] as const;
export type RunAt = (typeof RUN_AT)[number];

export const INJECT_INTO = { page: "MAIN", auto: "MAIN", content: "ISOLATED" } as const;
export type InjectInto = keyof typeof INJECT_INTO;

export const INCLUDE_MATCHES = ["*://*/*"];
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css"];
export const SOURCE_URL_PREFIX = "bay-userscript:///";
export const CHROME_TARGET = "chrome130";

const HEADER = /^\s*\/\/\s*==UserScript==\s*$/;
const FOOTER = /^\s*\/\/\s*==\/UserScript==\s*$/;
const ENTRY = /^\s*\/\/\s*@([\w-]+(?::[\w-]+)?)(?:\s+(.*?))?\s*$/;
const SLUG = /[^a-z0-9]+/g;

export class ScriptError extends Error {
  override name = "ScriptError";
}

export interface Meta {
  name: string;
  namespace: string;
  version: string;
  description: string;
  matches: string[];
  exclude_matches: string[];
  includes: string[];
  excludes: string[];
  run_at: RunAt;
  inject_into: InjectInto;
  noframes: boolean;
  warnings: string[];
  id: string;
  world: "MAIN" | "ISOLATED";
}

export interface Build {
  meta: Meta;
  source: string;
  path: string;
  js: string;
  sourcemap: { sources?: string[]; mappings?: string } | null;
  warnings: string[];
}

export function slug(name: string): string {
  const text = name
    .toLowerCase()
    .replace(SLUG, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return text || "script";
}

export function parseMeta(source: string, filename: string): Meta {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADER.test(line));
  const entries: Array<[string, string]> = [];
  if (start !== -1) {
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && FOOTER.test(line)) {
        end = i;
        break;
      }
    }
    if (end === -1) {
      throw new ScriptError(`${filename}: the // ==UserScript== block has no // ==/UserScript== line`);
    }
    for (let i = start + 1; i < end; i++) {
      const line = lines[i];
      if (!line) continue;
      const match = line.match(ENTRY);
      if (match && match[1]) {
        entries.push([match[1], (match[2] || "").trim()]);
      }
    }
  }

  const stem = basename(filename).split(".")[0] || "script";
  const meta: Meta = {
    name: stem,
    namespace: "",
    version: "",
    description: "",
    matches: [],
    exclude_matches: [],
    includes: [],
    excludes: [],
    run_at: "document-end",
    inject_into: "page",
    noframes: false,
    warnings: [],
    id: slug(stem),
    world: "MAIN",
  };

  const grants: string[] = [];
  for (const [key, value] of entries) {
    if (key === "name" && value) {
      meta.name = value;
      meta.id = slug(value);
    } else if (key === "namespace") {
      meta.namespace = value;
    } else if (key === "version") {
      meta.version = value;
    } else if (key === "description") {
      meta.description = value;
    } else if (key === "match") {
      meta.matches.push(checkMatch(value, key));
    } else if (key === "exclude-match") {
      meta.exclude_matches.push(checkMatch(value, key));
    } else if (key === "include") {
      checkGlob(value, key);
      meta.includes.push(value);
    } else if (key === "exclude") {
      checkGlob(value, key);
      meta.excludes.push(value);
    } else if (key === "run-at") {
      if (!RUN_AT.includes(value as RunAt)) {
        throw new ScriptError(`@run-at ${JSON.stringify(value)}: use document-start, document-end or document-idle`);
      }
      meta.run_at = value as RunAt;
    } else if (key === "inject-into") {
      if (!Object.hasOwn(INJECT_INTO, value)) {
        throw new ScriptError(`@inject-into ${JSON.stringify(value)}: use page, content or auto`);
      }
      meta.inject_into = value as InjectInto;
    } else if (key === "noframes") {
      meta.noframes = true;
    } else if (key === "grant") {
      grants.push(value);
    } else if (key === "require" || key === "resource") {
      meta.warnings.push(`@${key} ${value} is ignored: import the code instead (bundler bundles relative imports)`);
    }
  }

  meta.world = INJECT_INTO[meta.inject_into] || "MAIN";

  for (const grant of grants) {
    if (grant !== "none") {
      meta.warnings.push(`@grant ${grant} is ignored: Bay runs userscripts without GM_* APIs`);
    }
  }

  if (!meta.matches.length && !meta.includes.length) {
    meta.warnings.push("no @match or @include: the script runs nowhere");
  }

  return meta;
}

export function parseMatch(pattern: string, key = "match"): ReturnType<typeof urlmatch.parse> {
  try {
    return urlmatch.parse(pattern);
  } catch (error) {
    throw new ScriptError(`@${key} ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function checkMatch(pattern: string, key: string): string {
  parseMatch(pattern, key);
  return pattern;
}

export function checkGlob(glob: string, key: string): void {
  if (glob.length > 2 && glob.startsWith("/") && glob.endsWith("/")) {
    throw new ScriptError(`@${key} ${JSON.stringify(glob)}: regular expressions aren't supported; use @match patterns or * globs`);
  }
  if (!glob) {
    throw new ScriptError(`@${key} needs a value`);
  }
  for (let i = 0; i < glob.length; i++) {
    const code = glob.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new ScriptError(`@${key} ${JSON.stringify(glob)}: has control characters`);
    }
  }
}

export function rules(meta: Meta): {
  match: ReturnType<typeof urlmatch.parse>[];
  excludeMatch: ReturnType<typeof urlmatch.parse>[];
  include: ReturnType<typeof urlmatch.globPoints>[];
  exclude: ReturnType<typeof urlmatch.globPoints>[];
  runAt: string;
  noframes: boolean;
} {
  return {
    match: meta.matches.map((p) => parseMatch(p)),
    excludeMatch: meta.exclude_matches.map((p) => parseMatch(p, "exclude-match")),
    include: meta.includes.map((g) => urlmatch.globPoints(g)),
    exclude: meta.excludes.map((g) => urlmatch.globPoints(g)),
    runAt: meta.run_at,
    noframes: meta.noframes,
  };
}

export function urlRuns(meta: Meta, url: string): boolean {
  const spec = rules(meta);
  const parts = urlmatch.split(url);
  const web = parts !== null && (parts.scheme === "http" || parts.scheme === "https");
  const included = spec.match.some((p) => urlmatch.matches(p, parts)) || (web && spec.include.some((g) => urlmatch.globMatches(g, url)));
  const excluded = spec.excludeMatch.some((p) => urlmatch.matches(p, parts)) || spec.exclude.some((g) => urlmatch.globMatches(g, url));
  return included && !excluded;
}

export function defaultUrl(meta: Meta): string | null {
  for (const pattern of meta.matches) {
    if (pattern === "<all_urls>") continue;
    const [scheme, rest] = pattern.split("://");
    if (!rest || !scheme) continue;
    const [host, ...pathParts] = rest.split("/");
    const path = pathParts.join("/");
    if (!host || host.includes("*") || scheme === "file") continue;
    const finalScheme = scheme === "*" ? "https" : scheme;
    if (finalScheme !== "http" && finalScheme !== "https") continue;
    return `${finalScheme}://${host}/${path.split("*")[0]}`;
  }
  for (const glob of meta.includes) {
    if (!glob.includes("*") && !glob.includes("?") && /^https?:\/\//.test(glob)) {
      return glob;
    }
  }
  return null;
}

export function manifestEntries(meta: Meta, jsPath: string): Array<Record<string, unknown>> {
  const base = {
    js: [jsPath],
    run_at: meta.run_at.replace(/-/g, "_"),
    all_frames: !meta.noframes,
    world: meta.world,
  };
  const entries: Array<Record<string, unknown>> = [];
  if (meta.matches.length) {
    entries.push({
      matches: [...meta.matches],
      exclude_matches: [...meta.exclude_matches],
      include_globs: [],
      exclude_globs: [...meta.excludes],
      ...base,
    });
  }
  if (meta.includes.length) {
    const excluded = Array.from(new Set([...meta.exclude_matches, ...meta.matches]));
    entries.push({
      matches: [...INCLUDE_MATCHES],
      exclude_matches: excluded,
      include_globs: [...meta.includes],
      exclude_globs: [...meta.excludes],
      ...base,
    });
  }
  return entries;
}

function identity(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function lineage(path: string): string[] {
  let current = realpathSync(path);
  const found: string[] = [];
  while (true) {
    const id = identity(current);
    if (id) found.push(id);
    const parent = dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

function forbiddenRoots(dataDirs: string[] = []): string[] {
  const roots = [INSTALLED_DATA_DIR, ...dataDirs];
  if (process.env.BAY_DATA_DIR) {
    roots.push(resolve(process.env.BAY_DATA_DIR));
  }
  return roots;
}

function checkFile(real: string, forbidden: Set<string>, label: string): string[] {
  const chain = lineage(real);
  if (chain.some((id) => forbidden.has(id))) {
    throw new ScriptError(`refusing to bundle ${real}: it's in Bay's data folder`);
  }
  let stat;
  try {
    stat = statSync(real);
  } catch (error) {
    throw new ScriptError(`refusing to bundle ${real}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile()) {
    throw new ScriptError(`refusing to bundle ${real}: not a regular file`);
  }
  if (stat.nlink > 1) {
    throw new ScriptError(`refusing to bundle ${real}: it has other hard links`);
  }
  const name = basename(real).toLowerCase();
  if (!SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    throw new ScriptError(`refusing to bundle ${real}: ${label} must be ${SOURCE_EXTENSIONS.join(", ")} source`);
  }
  return chain;
}

function checkInputs(inputs: string[], baseDir: string, entryPath: string, dataDirs: string[] = []): void {
  const forbidden = new Set(
    forbiddenRoots(dataDirs)
      .map((r) => identity(r))
      .filter((id): id is string => Boolean(id)),
  );
  const tree = identity(dirname(entryPath));
  const shallow = tree === identity(process.env.HOME || "") || tree === identity("/");
  for (const name of inputs) {
    if (name.startsWith("<data:") || name.startsWith("bun:")) continue;
    if (name.startsWith("<")) {
      throw new ScriptError(`refusing to bundle ${name}: only files in the script's folder can be imported`);
    }
    const real = realpathSync(isAbsolute(name) ? name : resolve(baseDir, name));
    const chain = checkFile(real, forbidden, "imports");
    if (identity(real) === identity(entryPath)) continue;
    if (shallow) {
      throw new ScriptError(`refusing to bundle ${real}: a script in ${dirname(entryPath)} may only import files in a folder of its own; move it into one`);
    }
    if (!chain.slice(1).includes(tree!)) {
      throw new ScriptError(`refusing to bundle ${real}: imports must stay inside ${dirname(entryPath)} (symlinks resolved)`);
    }
  }
}

const B64: Record<string, number> = Object.fromEntries(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", (c, i) => [c, i]));

function vlq(segment: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    const digit = char !== undefined ? (B64[char] ?? 0) : 0;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >> 1) : value >> 1);
    shift = 0;
    value = 0;
  }
  return values;
}

export class SourceMap {
  readonly sources: string[];
  readonly lines: Array<Array<[number, number, number, number]>> = [];

  constructor(
    data: { sources?: string[]; mappings?: string } | null | undefined,
    readonly offset: number,
  ) {
    this.sources = data?.sources ? [...data.sources] : [];
    if (!data?.mappings) return;
    let source = 0;
    let line = 0;
    let column = 0;
    for (const text of data.mappings.split(";")) {
      const row: Array<[number, number, number, number]> = [];
      let generated = 0;
      for (const segment of text.split(",").filter(Boolean)) {
        const values = vlq(segment);
        const v0 = values[0];
        if (v0 !== undefined) generated += v0;
        const v1 = values[1];
        const v2 = values[2];
        const v3 = values[3];
        if (v0 !== undefined && v1 !== undefined && v2 !== undefined && v3 !== undefined) {
          source += v1;
          line += v2;
          column += v3;
          row.push([generated, source, line, column]);
        }
      }
      this.lines.push(row);
    }
  }

  lookup(line: number, column: number): [string, number, number] | null {
    const index = line - this.offset;
    if (index < 0 || index >= this.lines.length || !this.lines[index]?.length) return null;
    const row = this.lines[index];
    if (!row || !row[0]) return null;
    let best = row[0];
    for (const entry of row) {
      if (entry[0] > column) break;
      best = entry;
    }
    const sIdx = best[1];
    if (sIdx < 0 || sIdx >= this.sources.length) return null;
    const srcName = this.sources[sIdx];
    if (!srcName) return null;
    return [srcName, best[2] + 1, best[3] + 1];
  }
}

export async function build(path: string, options: { sourcemap?: boolean; dataDirs?: string[] } = {}): Promise<Build> {
  const resolvedPath = resolve(path);
  let source: string;
  try {
    source = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new ScriptError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const meta = parseMeta(source, resolvedPath);
  const entry = realpathSync(resolvedPath);
  const forbidden = new Set(
    forbiddenRoots(options.dataDirs)
      .map((r) => identity(r))
      .filter((id): id is string => Boolean(id)),
  );
  checkFile(entry, forbidden, "a script");

  const buildResult = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    sourcemap: options.sourcemap ? "external" : "none",
    plugins: [
      {
        name: "confine-userscript-inputs",
        setup(builder) {
          builder.onLoad({ filter: /.*/, namespace: "file" }, ({ path: input }) => {
            checkInputs([input], dirname(entry), entry, options.dataDirs);
          });
        },
      },
    ],
  }).catch((error: unknown) => {
    if (error instanceof AggregateError) {
      throw new ScriptError(error.errors.map((entry: Error) => entry.message).join("\n"));
    }
    throw error;
  });

  if (!buildResult.success) {
    const messages = buildResult.logs.map((l) => l.message).join("\n");
    throw new ScriptError(`build couldn't build ${path}:\n${messages}`);
  }

  let js = "";
  let sourcemap: { sources?: string[]; mappings?: string } | null = null;
  for (const output of buildResult.outputs) {
    if (output.kind === "entry-point") {
      js = await output.text();
    } else if (output.kind === "sourcemap" && options.sourcemap) {
      sourcemap = await output.json();
    }
  }

  const warnings: string[] = buildResult.logs.filter((l) => l.level === "warning").map((l) => l.message);

  return {
    meta,
    source,
    path: resolvedPath,
    js,
    sourcemap,
    warnings,
  };
}
