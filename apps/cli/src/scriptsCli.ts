import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "valibot";
import { dataDirFlag, portFlag, secondsFlag, toggle, wsFlag } from "./cliFlags.ts";
import { dataRoot, explicitDataRoot, requireControl, requireControlEffect, resolveEndpoint } from "./endpoint.ts";
import { CommandExit, complain, exitWith, failWith, messageOf, redactedOutput, say } from "./exit.ts";
import { JsonValueSchema } from "./guard.ts";
import { formatReport, runTest } from "./scriptsTest.ts";
import { lockStore, openStore, repairIfPresent, Store, StoreError, waitForStatus, type ScriptRecord, type StatusRecord } from "./scriptsStore.ts";
import { build, checkMatch, defaultUrl, slug, urlRuns } from "./userscript.ts";
import { isRecord } from "./util.ts";

const ProfileSchema = v.object({
  ok: v.optional(JsonValueSchema),
  error: v.optional(JsonValueSchema),
  disabled: v.optional(JsonValueSchema),
  removed: v.optional(JsonValueSchema),
});

type ProfileResult = v.InferOutput<typeof ProfileSchema>;

type ScriptsStatus = { profiles?: Record<string, ProfileResult> };

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
tsconfig.json is read). Imports must stay inside the script's own folder, and nothing from Bay's data folder.`;

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

// MARK: new

const scriptsNew = Command.make(
  "new",
  {
    name: Argument.String("name").pipe(Argument.withDescription("the script's name"), Argument.optional),
    match: Flag.String("match").pipe(Flag.withDescription("a page pattern it runs on (repeatable)"), Flag.atLeast(0)),
  },
  (input) =>
    Effect.gen(function* () {
      const name = Option.getOrElse(input.name, () => "").trim();

      if (!name || name.includes("\n")) return yield* failWith(1, "bay scripts new: give the script a name");

      const stem = /^[a-zA-Z0-9_.-]+$/.test(name) ? name : slug(name);
      const path = resolve(process.cwd(), `${stem}.user.ts`);
      const patterns = input.match.length ? [...input.match] : ["https://example.com/*"];

      yield* Effect.try({ try: () => patterns.forEach((pattern) => checkMatch(pattern, "match")), catch: (error) => error }).pipe(
        Effect.catch((error) => failWith(1, `bay scripts new: ${messageOf(error)}`)),
      );

      const content = NEW_TEMPLATE.replace(/\{name\}/g, name)
        .replace("{matches}", patterns.map((p) => `// @match       ${p}\n`).join(""))
        .replace("{quoted}", JSON.stringify(name));

      if (existsSync(path)) return yield* failWith(1, `bay scripts new: ${path} already exists`);

      yield* Effect.try({ try: () => writeFileSync(path, content, { encoding: "utf8", flag: "wx" }), catch: (error) => error }).pipe(
        Effect.catch((error) => failWith(1, `bay scripts new: ${messageOf(error)}`)),
      );

      yield* say(path);
    }),
).pipe(
  Command.withDescription("Scaffold NAME.user.ts in the current directory. Use --match PATTERN to choose where it runs."),
  Command.withShortDescription("scaffold NAME.user.ts in the current directory"),
);

// MARK: test

const scriptsTest = Command.make(
  "test",
  {
    file: Argument.String("file").pipe(Argument.withDescription("the script to test"), Argument.optional),
    url: Flag.String("url").pipe(Flag.withDescription("the page to open (else the first concrete @match)"), Flag.optional),
    expect: Flag.String("expect").pipe(Flag.withDescription("a JavaScript expression that must turn truthy"), Flag.optional),
    wait: secondsFlag("wait", 2, "listen this many seconds after the page loaded"),
    screenshot: Flag.String("screenshot").pipe(Flag.withDescription("save a PNG of the page here"), Flag.optional),
    keep: toggle("keep", "leave the test tab open"),
    json: toggle("json", "print the report as JSON"),
    dataDir: dataDirFlag,
    port: portFlag,
    ws: wsFlag,
  },
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* redactedOutput;

        const file = Option.getOrNull(input.file);

        if (!file) return yield* failWith(1, "bay scripts test: give FILE");

        const dataDir = Option.getOrUndefined(input.dataDir);

        // A test that can't start says so where the report would go.
        const notRun = (msg: string) =>
          (input.json ? say(JSON.stringify({ ok: false, ran: false, script: file, error: msg }, null, 2)) : complain(`bay scripts: ${msg}`)).pipe(
            Effect.andThen(exitWith(1)),
          );

        const built = yield* Effect.tryPromise({ try: () => build(file, { sourcemap: true, dataDirs: [dataRoot(dataDir)] }), catch: messageOf }).pipe(
          Effect.catch(notRun),
        );

        const targetUrl = Option.getOrUndefined(input.url) || defaultUrl(built.meta);

        if (!targetUrl) return yield* notRun("no @match gives a concrete page to open; pass --url URL");

        if (!urlRuns(built.meta, targetUrl)) built.meta.warnings.push(`${targetUrl} doesn't match the script's @match/@include rules, so it won't run there`);

        const endpoint = yield* resolveEndpoint({ ws: Option.getOrUndefined(input.ws), port: Option.getOrUndefined(input.port), dataDir }).pipe(
          Effect.catch((error) => failWith(2, `bay: ${error.message}`)),
        );

        const report = yield* runTest(
          built,
          targetUrl,
          endpoint,
          Option.getOrUndefined(input.expect),
          input.wait,
          Option.getOrUndefined(input.screenshot),
          input.keep,
        ).pipe(Effect.catch((error) => failWith(2, `bay: ${error.message}`)));

        yield* say(input.json ? JSON.stringify(report.to_dict(), null, 2) : formatReport(report));

        if (!report.ok) return yield* exitWith(1);
      }),
    ),
).pipe(Command.withDescription(TEST_DESCRIPTION), Command.withShortDescription("run it once in a background tab of its own and report what it did"));

// MARK: install and uninstall

// Whether Bay is still there to report: its control file is valid.
const controlAlive = (root: string) => () => {
  try {
    requireControl(root);

    return true;
  } catch {
    return false;
  }
};

// Applies a change under the store's lock, then waits for Bay to report it.
const applyChange = (root: string, change: (store: Store) => Effect.Effect<[string, number], CommandExit | StoreError>) =>
  Effect.gen(function* () {
    yield* requireControlEffect(root).pipe(Effect.catch((error) => failWith(2, `bay: ${error.message}`)));

    const [summary, generation, removedAll, store] = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openStore(root, true);

        if (!store) return yield* Effect.fail(new StoreError(`${root} doesn't exist`));

        yield* lockStore(store);

        const [summary, generation] = yield* change(store);

        return [summary, generation, !store.extensionPresent(), store] as const;
      }),
    ).pipe(Effect.catch((error) => (error instanceof CommandExit ? Effect.fail(error) : failWith(1, `bay scripts: ${error.message}`))));

    yield* say(summary);
    yield* say(`generation ${generation}`);

    const [outcome, status] = yield* waitForStatus(store, generation, controlAlive(root)).pipe(
      Effect.catch((error) => failWith(1, `bay scripts: ${error.message}`)),
    );

    if (outcome === "quit") return yield* say("Bay quit (or control was turned off) before applying it; it applies the change on its next launch");

    if (outcome === "timeout") {
      yield* say(`Bay hasn't reported generation ${generation} after 10 s: the outcome is unknown, it may still be applying it (see bay scripts list)`);

      return yield* exitWith(UNKNOWN_EXIT);
    }

    if (outcome === "superseded") yield* say(`a newer change (generation ${status?.generation}) replaced this one; Bay reported that one:`);

    const failed = printProfiles(status || {}, outcome === "superseded" ? false : removedAll);

    if (failed) return yield* exitWith(failed);
  });

// A store step that threw: its failure, as the store's.
const storeStep = <A>(run: () => A): Effect.Effect<A, StoreError> =>
  Effect.try({ try: run, catch: (error) => (error instanceof StoreError ? error : new StoreError(messageOf(error))) });

const scriptsInstall = Command.make(
  "install",
  {
    file: Argument.String("file").pipe(Argument.withDescription("the script to install"), Argument.optional),
    dataDir: dataDirFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const file = Option.getOrNull(input.file);

      if (!file) return yield* failWith(1, "bay scripts install: give FILE");

      const root = dataRoot(Option.getOrUndefined(input.dataDir));

      const built = yield* Effect.tryPromise({ try: () => build(file, { dataDirs: [root] }), catch: messageOf }).pipe(
        Effect.catch((msg) => failWith(1, `bay scripts: ${msg}`)),
      );

      for (const warning of [...built.meta.warnings, ...built.warnings]) yield* say(`warning: ${warning}`);

      if (!built.meta.matches.length && !built.meta.includes.length)
        return yield* failWith(1, "bay scripts: add an @match or @include line so the script runs somewhere");

      yield* applyChange(root, (store) =>
        storeStep((): [string, number] => {
          const [record, generation] = store.apply({ add: built });

          return [`${record.updated ? "updated" : "installed"} ${describe(record)}`, generation];
        }),
      );
    }),
).pipe(Command.withDescription(INSTALL_DESCRIPTION), Command.withShortDescription('build it and have Bay run it (needs "Let the bay command control Bay" on)'));

const scriptsUninstall = Command.make(
  "uninstall",
  {
    name: Argument.String("name").pipe(Argument.withDescription("the script's @name or id"), Argument.optional),
    dataDir: dataDirFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const name = Option.getOrNull(input.name);

      if (!name) return yield* failWith(1, "bay scripts uninstall: give NAME");

      const root = dataRoot(Option.getOrUndefined(input.dataDir));

      yield* applyChange(root, (store) =>
        Effect.gen(function* () {
          const found = yield* storeStep(() => store.find(name));

          if (!found) {
            const names = (yield* storeStep(() => store.installed())).map((m) => m.name || m.id).join(", ") || "none";

            return yield* failWith(1, `bay scripts: no installed script is named ${JSON.stringify(name)} (installed: ${names})`);
          }

          const [record, generation] = yield* storeStep(() => store.apply({ remove: String(found.id) }));

          const change: [string, number] = [`uninstalled ${record.name} (${record.id})`, generation];

          return change;
        }),
      );
    }),
).pipe(Command.withDescription("Remove an installed script by its @name or id."), Command.withShortDescription("remove an installed script by @name or id"));

export function describe(record: ScriptRecord): string {
  const version = record.version ? ` ${record.version}` : "";
  const matches = v.is(v.array(v.string()), record.matches) ? record.matches : [];
  const includes = v.is(v.array(v.string()), record.includes) ? record.includes : [];
  const where = [...matches, ...includes].join(", ") || "nowhere";
  const runAt = record.run_at || "document-end";
  const world = String(record.world || "MAIN").toLowerCase();

  return `${record.name}${version} (${record.id}): ${where} [${runAt}, ${world} world]`;
}

export function profileLines(status: ScriptsStatus, removed = false): [string[], boolean] {
  const profiles = status.profiles;
  const lines: string[] = [];
  let failed = false;

  if (!isRecord(profiles) || !Object.keys(profiles).length) {
    return [["Bay reported no profiles"], false];
  }

  for (const [name, result] of Object.entries(profiles)) {
    const parsed = v.safeParse(ProfileSchema, result);

    if (!parsed.success) {
      lines.push(`${name}: unknown result`);
    } else {
      const res = parsed.output;

      if (res.error) {
        failed = true;
        lines.push(`${name}: error ${String(res.error)}`);
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

export function printProfiles(status: ScriptsStatus, removed = false): number {
  const [lines, failed] = profileLines(status, removed);

  for (const line of lines) process.stdout.write(`${line}\n`);

  return failed ? 1 : 0;
}

// MARK: list

/** What the store holds, as the list shows it. */
type Listing = { scripts: ScriptRecord[]; generation: number; status: StatusRecord | null; removed: boolean };

const scriptsList = Command.make(
  "list",
  {
    json: toggle("json", "print the scripts as JSON"),
    dataDir: dataDirFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const dataDir = Option.getOrUndefined(input.dataDir);
      const root = dataRoot(dataDir);

      // The store is only repaired where Bay is trusted to be: a data dir that was given, or one Bay runs from.
      const trusted = explicitDataRoot(dataDir) !== null || controlAlive(root)();

      let note: string | null = null;

      if (trusted) {
        note = yield* repairIfPresent(root).pipe(Effect.catch((error) => failWith(1, `bay scripts: can't check the installed scripts (${error.message})`)));

        if (note && !input.json) yield* say(`repaired: ${note}`);
      }

      const listing = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(root, false);

          const nothing: Listing = { scripts: [], generation: 0, status: null, removed: false };

          if (!store) return nothing;

          return yield* storeStep((): Listing => {
            const generation = store.generation();

            return { scripts: store.installed(), generation, status: store.status(), removed: generation > 0 && !store.extensionPresent() };
          });
        }),
      ).pipe(Effect.catch((error) => failWith(1, `bay scripts: ${error.message}`)));

      const { scripts, generation, status, removed } = listing;

      if (input.json) return yield* say(JSON.stringify({ scripts, generation, status, repaired: note }, null, 2));

      if (!scripts.length) yield* say("no scripts installed");

      for (const record of scripts) {
        yield* say(describe(record));
        yield* say(`  source: ${record.source_file}`);
      }

      if (!generation) return;

      const reported = status?.generation;

      if (reported !== generation) return yield* say(`generation ${generation}, not reported by Bay yet${reported ? ` (it last reported ${reported})` : ""}`);

      const [lines] = profileLines(status || {}, removed);

      yield* say(`generation ${generation}, reported by Bay:`);

      for (const line of lines) yield* say(`  ${line}`);
    }),
).pipe(Command.withDescription("List the installed scripts and what Bay last reported about them."), Command.withShortDescription("the installed scripts"));

// MARK: The scripts command

export const scripts = Command.make("scripts").pipe(
  Command.withDescription(SCRIPTS_DESCRIPTION),
  Command.withShortDescription("write, test and install userscripts"),
  Command.withSubcommands([scriptsNew, scriptsTest, scriptsInstall, scriptsUninstall, scriptsList]),
);
