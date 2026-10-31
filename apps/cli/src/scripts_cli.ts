import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dataRoot, EndpointError, explicitDataRoot, requireControl, resolveEndpoint } from "./endpoint.ts";
import { installOutputRedaction } from "./redact.ts";
import { formatReport, runTest } from "./scripts_test.ts";
import { repairIfPresent, Store } from "./scripts_store.ts";
import { build, checkMatch, defaultUrl, slug, urlRuns } from "./userscript.ts";
import { numericOption, parseArguments } from "./args.ts";

export const SCRIPTS_DESCRIPTION = `Write userscripts in TypeScript or JavaScript, test them against real pages, and install them so Bay runs them.

A script is a .ts or .js file (a .user.js from Violentmonkey or Tampermonkey works as is) that starts with a
// ==UserScript== block. Keys Bay reads:
  @name @namespace @version @description
  @match, @exclude-match        Chrome match patterns (https://*.example.com/*, <all_urls>)
  @include, @exclude            globs over the whole URL: * any run, ? zero or one character, \\ escapes (http(s) only)
  @run-at                       document-start | document-end (default) | document-idle
  @inject-into                  page (default, the page's own JavaScript world) | content (an isolated world) | auto (page)
  @noframes                     top frame only (default: every frame)
@grant other than none, @require and @resource are ignored with a warning: there are no GM_* APIs, and relative
imports are bundled by the bundler instead (one IIFE, recent Chrome, not minified; types are stripped, not checked; no
tsconfig.json is read). Imports must stay inside the script's own folder, and nothing from Bay's data folder.

Commands:
  new NAME           scaffold NAME.user.ts in the current directory
  test FILE          run it once in a background tab of its own and report what it did
  install FILE       build it and have Bay run it (needs "Let the bay command control Bay" on)
  uninstall NAME     remove an installed script by @name or id
  list               the installed scripts
`;

export const TEST_DESCRIPTION = `Build FILE, open a background tab of its own, register the script at document start, open the page, and report.

The script runs where its @match/@include rules say, at its @run-at point, in the top frame and (without @noframes)
every iframe, cross-origin ones included. The report lists the script's own console output and uncaught exceptions
(with positions mapped back to your source files), errors the page threw itself, whether it ran in the top frame
and in iframes, and the --expect value. After the script ran and the page loaded, the test listens for --wait seconds (Chrome
reports an unhandled promise rejection about a second late), retrying --expect (a JavaScript expression, awaited,
in the page's world) until it's truthy. The tab closes at the end unless --keep.

@inject-into content runs in the page's world here (bay command connections can't create isolated worlds), with
a warning.

Exit status: 0 the script ran without uncaught exceptions and --expect was truthy, 1 otherwise (build error, the
page didn't match, an exception, a falsy --expect), 2 Bay can't be reached.

Examples:
  bay scripts test hide-sidebar.user.ts
  bay scripts test dark.user.ts --url https://github.com/ --expect 'document.documentElement.dataset.dark'
  bay scripts test x.user.ts --wait 5 --screenshot /tmp/x.png --json
`;

export const INSTALL_DESCRIPTION = `Build FILE and install it: the CLI keeps a copy under <data dir>/Scripts/scripts/<id>/ and regenerates the
Bay Scripts extension (<data dir>/Scripts/extension/), which Bay loads into every profile. Installing a script
with the same @name again updates it. Then it waits up to 10 s for Bay to report each profile.

Exit status: 0 loaded (or Bay quit and loads it on its next launch), 1 a build or load error, 2 Bay isn't
running or "Let the bay command control Bay" is off, 3 Bay didn't answer in 10 s (the outcome is unknown).
`;

const NEW_TEMPLATE = `// ==UserScript==
// @name        {name}
// @namespace   bay
// @version     0.1.0
// @description {name}
{matches}// @run-at      document-end
// @grant       none
// ==/UserScript==

console.log({quoted}, "ran on", location.href);
`;

export const UNKNOWN_EXIT = 3;

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function complain(text: string): void {
  process.stderr.write(`${text}\n`);
}

export async function runScriptsCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    say(SCRIPTS_DESCRIPTION);
    return 0;
  }

  if (sub === "new") {
    return runNew(args.slice(1));
  }
  if (sub === "test") {
    installOutputRedaction();
    return runTestCommand(args.slice(1));
  }
  if (sub === "install" || sub === "uninstall") {
    return runChange(sub, args.slice(1));
  }
  if (sub === "list") {
    return runList(args.slice(1));
  }

  complain(`bay scripts: unknown command ${JSON.stringify(sub)} (see bay scripts --help)`);
  return 1;
}

export function runNew(args: string[]): number {
  const { values, positionals } = parseArguments(
    args,
    {
      match: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    1,
  );
  if (values.help) {
    say("Scaffold NAME.user.ts in the current directory. Use --match PATTERN to choose where it runs.");
    return 0;
  }
  const name = (positionals[0] ?? "").trim();
  const matches = values.match ?? [];

  if (!name || name.includes("\n")) {
    complain("bay scripts new: give the script a name");
    return 1;
  }

  const stem = /^[a-zA-Z0-9_.-]+$/.test(name) ? name : slug(name);
  const path = resolve(process.cwd(), `${stem}.user.ts`);
  const patterns = matches.length ? matches : ["https://example.com/*"];

  try {
    for (const pattern of patterns) {
      checkMatch(pattern, "match");
    }
  } catch (error) {
    complain(`bay scripts new: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const matchesLines = patterns.map((p) => `// @match       ${p}\n`).join("");
  const content = NEW_TEMPLATE.replace(/\{name\}/g, name)
    .replace("{matches}", matchesLines)
    .replace("{quoted}", JSON.stringify(name));

  if (existsSync(path)) {
    complain(`bay scripts new: ${path} already exists`);
    return 1;
  }

  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    complain(`bay scripts new: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  say(path);
  return 0;
}

export async function runTestCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArguments(
    args,
    {
      url: { type: "string" },
      expect: { type: "string" },
      wait: { type: "string" },
      screenshot: { type: "string" },
      keep: { type: "boolean" },
      json: { type: "boolean" },
      "data-dir": { type: "string" },
      port: { type: "string" },
      ws: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    1,
  );
  if (values.help) {
    say(TEST_DESCRIPTION);
    return 0;
  }
  const file = positionals[0];
  const url = values.url;
  const expectExpr = values.expect;
  const wait = numericOption(values.wait, "--wait", 2)!;
  const screenshot = values.screenshot;
  const keep = values.keep ?? false;
  const asJson = values.json ?? false;
  const dataDir = values["data-dir"];
  const port = numericOption(values.port, "--port");
  const ws = values.ws;

  if (!file) {
    complain("bay scripts test: give FILE");
    return 1;
  }

  const root = dataRoot(dataDir);
  let built;
  try {
    built = await build(file, { sourcemap: true, dataDirs: [root] });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (asJson) {
      say(JSON.stringify({ ok: false, ran: false, script: file, error: msg }, null, 2));
    } else {
      complain(`bay scripts: ${msg}`);
    }
    return 1;
  }

  const targetUrl = url || defaultUrl(built.meta);
  if (!targetUrl) {
    const msg = "no @match gives a concrete page to open; pass --url URL";
    if (asJson) {
      say(JSON.stringify({ ok: false, ran: false, script: file, error: msg }, null, 2));
    } else {
      complain(`bay scripts: ${msg}`);
    }
    return 1;
  }

  if (!urlRuns(built.meta, targetUrl)) {
    built.meta.warnings.push(`${targetUrl} doesn't match the script's @match/@include rules, so it won't run there`);
  }

  let endpoint;
  try {
    endpoint = await resolveEndpoint({ ws, port, dataDir });
  } catch (error) {
    complain(`bay: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let report;
  try {
    report = await runTest(built, targetUrl, endpoint, expectExpr, wait, screenshot, keep);
  } catch (error) {
    if (error instanceof EndpointError) {
      complain(`bay: ${error.message}`);
      return 2;
    }
    complain(`bay scripts test: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (asJson) {
    say(JSON.stringify(report.to_dict(), null, 2));
  } else {
    say(formatReport(report));
  }
  return report.ok ? 0 : 1;
}

export async function runChange(kind: "install" | "uninstall", args: string[]): Promise<number> {
  const { values, positionals } = parseArguments(
    args,
    {
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    1,
  );
  if (values.help) {
    say(kind === "install" ? INSTALL_DESCRIPTION : "Remove an installed script by its @name or id.");
    return 0;
  }
  const targetArg = positionals[0];
  const dataDir = values["data-dir"];

  if (!targetArg) {
    complain(`bay scripts ${kind}: give ${kind === "install" ? "FILE" : "NAME"}`);
    return 1;
  }

  const root = dataRoot(dataDir);
  let built = null;

  if (kind === "install") {
    try {
      built = await build(targetArg, { dataDirs: [root] });
    } catch (error) {
      complain(`bay scripts: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    for (const w of [...built.meta.warnings, ...built.warnings]) {
      say(`warning: ${w}`);
    }
    if (!built.meta.matches.length && !built.meta.includes.length) {
      complain("bay scripts: add an @match or @include line so the script runs somewhere");
      return 1;
    }
  }

  try {
    requireControl(root);
  } catch (error) {
    complain(`bay: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const store = new Store(root);
  let summary = "";
  let generation = 0;
  let removedAll = false;

  try {
    store.open(true);
    store.lock();
    if (built !== null) {
      const [record, gen] = store.apply({ add: built });
      generation = gen;
      summary = `${record.updated ? "updated" : "installed"} ${describe(record)}`;
    } else {
      const found = store.find(targetArg);
      if (!found) {
        const names =
          store
            .installed()
            .map((m) => m.name || m.id)
            .join(", ") || "none";
        complain(`bay scripts: no installed script is named ${JSON.stringify(targetArg)} (installed: ${names})`);
        return 1;
      }
      const [record, gen] = store.apply({ remove: String(found.id) });
      generation = gen;
      summary = `uninstalled ${record.name} (${record.id})`;
    }
    removedAll = !store.extensionPresent();
  } catch (error) {
    complain(`bay scripts: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    store.close();
  }

  say(summary);
  say(`generation ${generation}`);

  const alive = () => {
    try {
      requireControl(root);
      return true;
    } catch {
      return false;
    }
  };

  const [outcome, status] = store.waitStatus(generation, alive);
  if (outcome === "quit") {
    say("Bay quit (or control was turned off) before applying it; it applies the change on its next launch");
    return 0;
  }
  if (outcome === "timeout") {
    say(`Bay hasn't reported generation ${generation} after 10 s: the outcome is unknown, it may still be applying it (see bay scripts list)`);
    return UNKNOWN_EXIT;
  }
  if (outcome === "superseded") {
    say(`a newer change (generation ${status?.generation}) replaced this one; Bay reported that one:`);
    removedAll = false;
  }
  return printProfiles(status || {}, removedAll);
}

export function describe(record: Record<string, unknown>): string {
  const version = record.version ? ` ${record.version}` : "";
  const matches = Array.isArray(record.matches) ? (record.matches as string[]) : [];
  const includes = Array.isArray(record.includes) ? (record.includes as string[]) : [];
  const where = [...matches, ...includes].join(", ") || "nowhere";
  const runAt = record.run_at || "document-end";
  const world = String(record.world || "MAIN").toLowerCase();
  return `${record.name}${version} (${record.id}): ${where} [${runAt}, ${world} world]`;
}

export function profileLines(status: Record<string, unknown>, removed = false): [string[], boolean] {
  const profiles = status.profiles as Record<string, unknown> | undefined;
  const lines: string[] = [];
  let failed = false;
  if (typeof profiles !== "object" || !profiles || !Object.keys(profiles).length) {
    return [["Bay reported no profiles"], false];
  }
  for (const [name, result] of Object.entries(profiles)) {
    if (typeof result !== "object" || result === null) {
      lines.push(`${name}: unknown result`);
    } else {
      const res = result as Record<string, unknown>;
      if (res.error) {
        failed = true;
        lines.push(`${name}: error ${res.error}`);
      } else if (res.disabled) {
        lines.push(`${name}: turned off in Extensions, so the scripts don't run there`);
      } else if (res.removed) {
        lines.push(`${name}: removed`);
      } else if (res.ok) {
        lines.push(`${name}: ${removed ? "removed" : "loaded"}`);
      } else {
        lines.push(`${name}: unknown result`);
      }
    }
  }
  return [lines, failed];
}

export function printProfiles(status: Record<string, unknown>, removed = false): number {
  const [lines, failed] = profileLines(status, removed);
  for (const line of lines) {
    say(line);
  }
  return failed ? 1 : 0;
}

export function runList(args: string[]): number {
  const { values } = parseArguments(args, {
    json: { type: "boolean" },
    "data-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) {
    say("List the installed scripts and what Bay last reported about them.");
    return 0;
  }
  const asJson = values.json ?? false;
  const dataDir = values["data-dir"];

  const root = dataRoot(dataDir);
  let trusted = explicitDataRoot(dataDir) !== null;
  if (!trusted) {
    try {
      requireControl(root);
      trusted = true;
    } catch {
      trusted = false;
    }
  }

  let note: string | null = null;
  if (trusted) {
    try {
      note = repairIfPresent(root);
    } catch (error) {
      complain(`bay scripts: can't check the installed scripts (${error instanceof Error ? error.message : String(error)})`);
      return 1;
    }
    if (note && !asJson) {
      say(`repaired: ${note}`);
    }
  }

  const store = new Store(root);
  let scripts: Array<Record<string, unknown>> = [];
  let generation = 0;
  let status: Record<string, unknown> | null = null;
  let removed = false;

  try {
    store.open(false);
    scripts = store.installed();
    generation = store.generation();
    status = store.status();
    removed = generation > 0 && !store.extensionPresent();
  } catch (error) {
    complain(`bay scripts: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    store.close();
  }

  if (asJson) {
    say(JSON.stringify({ scripts, generation, status, repaired: note }, null, 2));
    return 0;
  }

  if (!scripts.length) {
    say("no scripts installed");
  }
  for (const record of scripts) {
    say(describe(record));
    say(`  source: ${record.source_file}`);
  }
  if (generation) {
    const reported = status?.generation;
    if (reported === generation) {
      const [lines] = profileLines(status || {}, removed);
      say(`generation ${generation}, reported by Bay:`);
      for (const line of lines) {
        say(`  ${line}`);
      }
    } else {
      say(`generation ${generation}, not reported by Bay yet${reported ? ` (it last reported ${reported})` : ""}`);
    }
  }
  return 0;
}
