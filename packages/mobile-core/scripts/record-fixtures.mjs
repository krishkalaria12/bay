// Records what the TypeScript code the core replaces does while the tests run, as fixtures the Rust port must match:
//   node packages/mobile-core/scripts/record-fixtures.mjs store|input
// A load hook wraps the suite's exported functions; each call's input and output goes to fixtures/<suite>.jsonl once
// (identical calls are kept once). The Rust tests in crates/bay-core/tests/<suite>_fixtures.rs replay every line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");

const SUITES = {
  store: {
    wrap: {
      "apps/mobile/src/store/model.ts": [
        "reduceBrowserData",
        "parseBrowserData",
        "persistedBrowserData",
        "mergeHistory",
        "parsePreferences",
        "parseSiteSetting",
      ],
    },
    runs: [{ cwd: "apps/mobile", tests: ["tests/*.test.ts", join(here, "store-scenarios.test.ts")] }],
  },
  input: {
    wrap: {
      "packages/core/src/input.ts": ["parseUrl", "hostOf", "fixupUrl", "searchUrlFor", "resolveInput", "classifyPaste", "urlForDisplay"],
      "packages/core/src/appUrls.ts": ["toAppUrl", "appUrlOrigin"],
      "packages/core/src/cleanUrl.ts": ["cleanUrl", "isTrackingParam"],
      "packages/core/src/idn.ts": ["displayHost", "hostSpoofReason", "labelSpoofReason", "punycodeDecode", "punycodeEncode", "similarTopDomain"],
      "packages/core/src/engines.ts": ["searchUrl", "suggestRequestUrl", "parseSuggestions", "engineHost"],
      "packages/core/src/calculator.ts": ["calculate", "evaluate", "formatNumber"],
      "packages/core/src/emoji.ts": ["findEmoji"],
      "packages/core/src/quickCreate.ts": ["matchQuickCreate"],
      "packages/core/src/suggest.ts": ["buildSuggestions", "displayUrl"],
      "apps/mobile/src/browser/address.ts": ["engineFor", "resolveAddress", "isWebURL", "siteName"],
    },
    runs: [
      { cwd: "packages/core", tests: ["src/*.test.ts"] },
      { cwd: "apps/mobile", tests: ["tests/*.test.ts", join(here, "input-scenarios.test.ts")] },
    ],
  },
};

/** Whether a value survives JSON: no functions, maps or other live objects. */
function plain(value) {
  if (value === null || value === undefined) return true;

  if (Array.isArray(value)) return value.every(plain);

  // Object() wraps a string, number or boolean in its own kind; a function or a map is no plain object.
  const kind = Object.getPrototypeOf(Object(value));

  if (kind === String.prototype || kind === Number.prototype || kind === Boolean.prototype) return true;

  return kind === Object.prototype && Object.values(value).every(plain);
}

if (process.env.BAY_RECORD_FILE) {
  // Inside a test process: wrap the suite's functions and append each call.
  const file = process.env.BAY_RECORD_FILE;
  const suite = SUITES[process.env.BAY_RECORD_SUITE];

  globalThis.__bayRecord = (fn, args, run) => {
    // A suggestion list asked for without a time gets the current one, recorded, so it replays the same.
    if (fn === "buildSuggestions" && args[2]?.now === undefined) args = [args[0], args[1], { ...args[2], now: Date.now() }];

    const recordable = plain(args);
    const input = recordable ? JSON.stringify(args) : null;
    let result;

    try {
      result = run(args);
    } catch (error) {
      if (recordable) appendFileSync(file, `${JSON.stringify({ fn, args: JSON.parse(input), error: String(error?.message ?? error) })}\n`);

      throw error;
    }

    if (recordable && plain(result)) {
      appendFileSync(
        file,
        `${JSON.stringify({ fn, args: JSON.parse(input), result: result === undefined ? null : result, same: args.length > 0 && result === args[0] })}\n`,
      );
    }

    return result;
  };

  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const path = Object.keys(suite.wrap).find((suffix) => url.endsWith(`/${suffix}`));

      if (!path) return loaded;

      let source = String(loaded.source);

      for (const name of suite.wrap[path]) {
        const declared = source.includes(`export function ${name}(`);

        source = declared
          ? source.replace(`export function ${name}(`, `function __bay_${name}(`)
          : source.replace(`export const ${name} =`, `const __bay_${name} =`);
        source += `\nexport function ${name}(...args) { return globalThis.__bayRecord(${JSON.stringify(name)}, args, (a) => __bay_${name}(...a)); }\n`;
      }

      return { ...loaded, source };
    },
  });
} else {
  // The driver: run the suite's tests with this file imported, then keep each distinct call once.
  const name = process.argv[2];
  const suite = SUITES[name];

  if (!suite) throw new Error(`suites: ${Object.keys(SUITES).join(", ")}`);

  const raw = join(here, `../fixtures/${name}.raw.jsonl`);

  rmSync(raw, { force: true });

  for (const run of suite.runs) {
    const result = spawnSync(
      process.execPath,
      ["--import", fileURLToPath(import.meta.url), "--test", "--test-concurrency=1", "--test-reporter=tap", ...run.tests],
      {
        cwd: join(repo, run.cwd),
        env: { ...process.env, BAY_RECORD_FILE: raw, BAY_RECORD_SUITE: name, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );

    const summary = String(result.stdout)
      .split("\n")
      .filter((line) => /^# (pass|fail) /.test(line));

    console.log(`${run.cwd}: ${summary.join(", ")}`);
  }

  if (!existsSync(raw)) throw new Error("no calls recorded");

  const seen = new Set();
  const lines = [];

  for (const line of readFileSync(raw, "utf8").split("\n")) {
    if (!line) continue;

    const hash = createHash("sha256").update(line).digest("hex");

    if (seen.has(hash)) continue;

    seen.add(hash);
    lines.push(line);
  }

  rmSync(raw);
  writeFileSync(join(here, `../fixtures/${name}.jsonl`), `${lines.join("\n")}\n`);

  const counts = {};

  for (const line of lines) counts[JSON.parse(line).fn] = (counts[JSON.parse(line).fn] ?? 0) + 1;

  console.log(`${lines.length} distinct calls`, counts);
}
