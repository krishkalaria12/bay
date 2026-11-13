// The bay command: its commands, their flags, and how each one ends.
//
// The commands are Effect CLI commands. A handler is an Effect that either succeeds (status 0) or fails with the
// status the shell sees (exit.ts); what it has to say it prints on the way. A flag the parser rejects is one line on
// stderr, `bay <command>: <why>`, and status 1; help and the version are printed as the parser builds them.
import { BunServices } from "@effect/platform-bun";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Argument, CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/cli";
import { readFileSync } from "node:fs";
import { dataRoot, EndpointError, explicitDataRoot, resolveEndpoint } from "./endpoint.ts";
import { CommandExit, exitWith, failWith, messageOf, redactedOutput, say } from "./exit.ts";
import * as runner from "./runner.ts";
import { dataDirFlag, portFlag, secondsFlag, toggle, wsFlag } from "./cliFlags.ts";
import { scripts } from "./scriptsCli.ts";
import { install as installSkills, TARGETS } from "./skills.ts";
import { VERSION } from "./version.ts";
import { redact } from "./redact.ts";

export const DESCRIPTION = "Control a running Bay from the terminal.";

export const EXEC_DESCRIPTION = `Run TypeScript/JavaScript against the running Bay, with top-level await.

In scope:
  browser        session attached to Bay (closing it only drops the connection)
  tab            the web page the user is looking at; NoPageTab on first use when there is none (New Tab)
  tabs           every web page tab (http, https, about, data, blob), plus the ones newTab opens
  newTab(url, background=true) / new_tab(...)  open a tab and return it once the page has loaded
  js(expression, tab=null)                     evaluate JavaScript in tab (else the user's tab, else the last newTab) and return its value
  pinned()       the user's favorites and pinned tabs from Bay's saved session
  history(options) recent history per URL, newest first; domains=true rolls it up per domain.
                 Both read Bay's data dir (the token path's, or --data-dir/$BAY_DATA_DIR) and need control on.
  Key and browser exports (Tab, Element, ElementNotFound, WaitElementTimeout, ...)

The value of the last expression is printed (strings as is, other values as inspect, or JSON with --json).
Bay keeps running after every exec.

Exit status: 0 done, 1 the code raised or timed out, 2 Bay can't be reached or closed the connection, 130 interrupted.

Endpoint: --ws, else --port (plain DevTools servers only), else $BAY_CDP_URL, else
<data dir>/BayControl.json on Linux and Windows, or <data dir>/Chromium/BayControl.json on macOS,
with --data-dir or $BAY_DATA_DIR, else the installed Bay's native data directory.`;

export const SKILLS_DESCRIPTION = `Install the bay agent skill (SKILL.md) so coding agents know how to drive Bay.

Targets and where they install (user level; --project uses the current directory):
  general       ~/.agents/skills            ./.agents/skills
  codex         ~/.agents/skills            ./.agents/skills
  claude-code   ~/.claude/skills            ./.claude/skills
  cursor        ~/.cursor/skills            ./.cursor/skills
  opencode      ~/.config/opencode/skills   ./.opencode/skills`;

// MARK: exec

// Where the code comes from: the argument, a file, or stdin.
const readSource = (code: string | null, file: string | null): Effect.Effect<{ source: string; filename: string }, CommandExit> =>
  Effect.gen(function* () {
    const stdin = Effect.promise(() => Bun.stdin.text()).pipe(Effect.map((source) => ({ source, filename: "<stdin>" })));

    if (file !== null) {
      if (code !== null) return yield* failWith(1, "bay exec: give CODE or -f FILE, not both");

      if (file === "-") return yield* stdin;

      return yield* Effect.try({
        try: () => ({ source: readFileSync(file, "utf8"), filename: file }),
        catch: (error) => error,
      }).pipe(Effect.catch((error) => failWith(1, `bay exec: ${messageOf(error)}`)));
    }

    if (code === null || code === "-") {
      if (code === null && process.stdin.isTTY) return yield* failWith(1, "bay exec: give CODE, - (stdin) or -f FILE");

      return yield* stdin;
    }

    return { source: code, filename: "<exec>" };
  });

export const exec = Command.make(
  "exec",
  {
    code: Argument.String("code").pipe(Argument.withDescription("the code to run, or - for stdin"), Argument.optional),
    file: Flag.String("file").pipe(Flag.withAlias("f"), Flag.withDescription("run FILE (- for stdin)"), Flag.optional),
    dataDir: dataDirFlag,
    port: portFlag,
    ws: wsFlag,
    timeout: secondsFlag("timeout", 300, "give up after SECONDS (0 never)"),
    json: toggle("json", "print the value as JSON"),
  },
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* redactedOutput;

        const dataDir = Option.getOrUndefined(input.dataDir);
        const { source, filename } = yield* readSource(Option.getOrNull(input.code), Option.getOrNull(input.file));

        // A syntax error is the user's to fix, before Bay is reached at all.
        yield* Effect.try({ try: () => runner.compileCode(source, filename), catch: (error) => error }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => runner.printErr(runner.formatSyntaxError(error instanceof Error ? error : new Error(String(error))))).pipe(
              Effect.andThen(exitWith(1)),
            ),
          ),
        );

        const endpoint = yield* resolveEndpoint({ ws: Option.getOrUndefined(input.ws), port: Option.getOrUndefined(input.port), dataDir }).pipe(
          Effect.catch((error) => Effect.sync(() => runner.printErr(`bay: ${error.message}`)).pipe(Effect.andThen(exitWith(2)))),
        );

        const root = endpoint.explicit ? explicitDataRoot(dataDir) : dataRoot(dataDir);

        const value = yield* runner.runCodeEffect(source, filename, endpoint, input.timeout || null, root ?? undefined).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (error instanceof EndpointError) {
                runner.printErr(`bay: ${error.message}`);

                return yield* exitWith(2);
              }

              if (error instanceof runner.UserCodeError) runner.printErr(runner.formatUserError(error));
              else runner.printErr(`bay exec: ${error.message}`);

              return yield* exitWith(1);
            }),
          ),
        );

        const text = yield* Effect.try({ try: () => runner.formatValue(value, input.json), catch: (error) => error }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => runner.printErr(`bay exec: can't print the result as JSON (${messageOf(error)})`)).pipe(Effect.andThen(exitWith(1))),
          ),
        );

        if (text !== null) yield* say(text);
      }),
    ),
).pipe(
  Command.withDescription(EXEC_DESCRIPTION),
  Command.withShortDescription("run code against the running Bay"),
  Command.withExamples([
    { command: "bay exec 'await tab.title()'", description: "the title of the page the user is on" },
    { command: `bay exec 't = await newTab("https://example.com"); await t.title()'`, description: "open a page and read it" },
    { command: "bay exec -f script.ts --json", description: "run a file, and print its value as JSON" },
    { command: "echo 'tabs.length' | bay exec -", description: "run code from stdin" },
    { command: "bay exec 'await history({ days: 1, domains: true })' --json", description: "the last day's history per domain" },
  ]),
);

// MARK: skills

const skillsInstall = Command.make(
  "install",
  {
    target: Flag.Literals("target", [...TARGETS.keys()].sort()).pipe(Flag.withDescription("where the skill goes (repeatable)"), Flag.atLeast(0)),
    project: toggle("project", "install into the current directory instead of your home folder"),
  },
  (input) =>
    Effect.gen(function* () {
      const status = yield* Effect.sync(() => installSkills(input.target.length ? [...input.target] : ["general"], input.project));

      if (status !== 0) return yield* exitWith(status);
    }),
).pipe(
  Command.withDescription("Install the bay agent skill: --target TARGET (repeatable, default general), --project for the current directory."),
  Command.withShortDescription("install the skill"),
);

export const skills = Command.make("skills").pipe(
  Command.withDescription(SKILLS_DESCRIPTION),
  Command.withShortDescription("install the bay agent skill"),
  Command.withSubcommands([skillsInstall]),
);

// MARK: The command

export const bay = Command.make("bay").pipe(Command.withDescription(DESCRIPTION), Command.withSubcommands([exec, scripts, skills]));

// The parser's output: help and the version as it builds them, and a rejected invocation as one line on stderr.
const presenter: CliOutput.Presenter = {
  present: (event) => {
    if (event._tag === "Version") return say(`bay ${VERSION}`);

    if (event._tag === "InvalidInvocation") {
      const [first] = event.errors;
      // Named as the top command, as the error lines of every bay command are: `bay scripts: ...`.
      const command = event.commandPath.slice(0, 2).join(" ") || "bay";

      return Effect.sync(() => void process.stderr.write(redact(`${command}: ${first ? first.message : "invalid arguments"}\n`)));
    }

    return CliOutput.defaultPresenter.present(event);
  },
};

/** What the command runs with: Bun's platform, the presenter, and the global flags it keeps. */
export const cliLayer = Layer.mergeAll(
  BunServices.layer,
  CliOutput.layerPresenter(presenter),
  CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions] }),
);

/** The status a run of the command ended with. */
export const statusOf = (exit: Exit.Exit<unknown, unknown>): number => {
  if (Exit.isSuccess(exit)) return 0;

  if (Cause.hasInterruptsOnly(exit.cause)) return 130;

  const error = Cause.squash(exit.cause);

  if (error instanceof CommandExit) return error.status;

  // Help the user asked for, or a command with no handler: help, and success. A parse error: status 1.
  if (error instanceof CliError.ShowHelp) return error.errors.length ? 1 : 0;

  if (CliError.isCliError(error)) return 1;

  process.stderr.write(`bay: ${messageOf(error)}\n`);

  return 1;
};

/** The command, for these arguments. */
export const program = (argv: readonly string[]) => Command.runWith(bay, { version: VERSION })(argv).pipe(Effect.provide(cliLayer));

/** Runs the command for `argv` and gives back its status. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return statusOf(await Effect.runPromiseExit(program(argv)));
}
