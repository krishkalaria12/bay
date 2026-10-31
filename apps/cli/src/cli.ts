import { readFileSync } from "node:fs";
import { dataRoot, EndpointError, explicitDataRoot, resolveEndpoint } from "./endpoint.ts";
import { drainOutput, installOutputRedaction } from "./redact.ts";
import * as runner from "./runner.ts";
import { runScriptsCommand } from "./scripts_cli.ts";
import { install as installSkills, TARGETS } from "./skills.ts";
import { VERSION } from "./version.ts";
import { ArgumentError, numericOption, parseArguments } from "./args.ts";

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

Examples:
  bay exec 'await tab.title()'
  bay exec 't = await newTab("https://example.com"); await t.title()'
  bay exec -f script.ts --json
  echo 'tabs.length' | bay exec -
  bay exec 'await history({ days: 1, domains: true })' --json
`;

export const EXEC_EPILOG = `Endpoint: --ws, else --port (plain DevTools servers only), else $BAY_CDP_URL, else
<data dir>/Chromium/BayControl.json with --data-dir or $BAY_DATA_DIR, else the installed Bay's.
`;

export const SKILLS_DESCRIPTION = `Install the bay agent skill (SKILL.md) so coding agents know how to drive Bay.

Targets and where they install (user level; --project uses the current directory):
  general       ~/.agents/skills            ./.agents/skills
  codex         ~/.agents/skills            ./.agents/skills
  claude-code   ~/.claude/skills            ./.claude/skills
  cursor        ~/.cursor/skills            ./.cursor/skills
  opencode      ~/.config/opencode/skills   ./.opencode/skills
`;

function printHelp(): void {
  process.stdout.write(`bay ${VERSION}

${DESCRIPTION}

Commands:
  exec       run code against the running Bay
  scripts    write, test and install userscripts
  skills     install the bay agent skill
  --version  print version
`);
}

function printExecHelp(): void {
  process.stdout.write(`bay exec: run code against the running Bay

${EXEC_DESCRIPTION}
${EXEC_EPILOG}
`);
}

function printSkillsHelp(): void {
  process.stdout.write(`bay skills: install the bay agent skill

${SKILLS_DESCRIPTION}
Commands:
  install [--target TARGET] [--project]
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    process.stdout.write(`bay ${VERSION}\n`);
    return 0;
  }
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  try {
    if (command === "exec") return await runExec(rest);
    if (command === "skills") return runSkills(rest);
    if (command === "scripts") return await runScriptsCommand(rest);
  } catch (error) {
    if (!(error instanceof ArgumentError)) throw error;
    process.stderr.write(`bay ${command}: ${error.message}\n`);
    return 1;
  }

  process.stderr.write(`unknown command: ${command}\n`);
  printHelp();
  return 1;
}

export async function runExec(args: string[]): Promise<number> {
  installOutputRedaction();
  try {
    return await innerRunExec(args);
  } finally {
    drainOutput();
  }
}

async function innerRunExec(args: string[]): Promise<number> {
  const { values, positionals } = parseArguments(
    args,
    {
      file: { type: "string", short: "f" },
      "data-dir": { type: "string" },
      port: { type: "string" },
      ws: { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    1,
  );
  if (values.help) {
    printExecHelp();
    return 0;
  }
  const code = positionals[0] ?? null;
  const file = values.file;
  const dataDir = values["data-dir"];
  const port = numericOption(values.port, "--port");
  const ws = values.ws;
  const timeout = numericOption(values.timeout, "--timeout", 300)!;
  const asJson = values.json ?? false;

  let source = "";
  let filename = "<exec>";

  if (file) {
    if (code !== null) {
      process.stderr.write("bay exec: give CODE or -f FILE, not both\n");
      return 1;
    }
    if (file === "-") {
      source = await Bun.stdin.text();
      filename = "<stdin>";
    } else {
      try {
        source = readFileSync(file, "utf8");
        filename = file;
      } catch (error) {
        process.stderr.write(`bay exec: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
  } else if (code === null || code === "-") {
    if (code === null && process.stdin.isTTY) {
      process.stderr.write("bay exec: give CODE, - (stdin) or -f FILE\n");
      return 1;
    }
    source = await Bun.stdin.text();
    filename = "<stdin>";
  } else {
    source = code;
  }

  try {
    runner.compileCode(source, filename);
  } catch (error) {
    runner.printErr(runner.formatSyntaxError(error instanceof Error ? error : new Error(String(error))));
    return 1;
  }

  let endpoint;
  try {
    endpoint = await resolveEndpoint({ ws, port, dataDir });
  } catch (error) {
    runner.printErr(`bay: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const root = endpoint.explicit ? explicitDataRoot(dataDir) : dataRoot(dataDir);

  let value: unknown;
  try {
    value = await runner.runCode(source, filename, endpoint, timeout || null, root ?? undefined);
  } catch (error) {
    if (error instanceof EndpointError) {
      runner.printErr(`bay: ${error.message}`);
      return 2;
    }
    if (error instanceof runner.UserCodeError) {
      runner.printErr(runner.formatUserError(error));
      return 1;
    }
    if (error instanceof runner.ExecTimeout) {
      runner.printErr(`bay exec: ${error.message}`);
      return 1;
    }
    if (error instanceof runner.ExecInterrupted) return 130;
    runner.printErr(`bay exec: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    const text = runner.formatValue(value, asJson);
    if (text !== null) {
      process.stdout.write(`${text}\n`);
    }
  } catch (error) {
    runner.printErr(`bay exec: can't print the result as JSON (${error instanceof Error ? error.message : String(error)})`);
    return 1;
  }

  return 0;
}

export function runSkills(args: string[]): number {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    printSkillsHelp();
    return 0;
  }
  if (args[0] !== "install") throw new ArgumentError(`unknown command: ${args[0]}`);
  const { values } = parseArguments(args.slice(1), {
    project: { type: "boolean" },
    target: { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) {
    printSkillsHelp();
    return 0;
  }
  const targets = values.target ?? ["general"];
  for (const target of targets) {
    if (!Object.hasOwn(TARGETS, target)) throw new ArgumentError(`invalid target: ${target}. Choices: ${Object.keys(TARGETS).sort().join(", ")}`);
  }
  return installSkills(targets, values.project ?? false);
}
