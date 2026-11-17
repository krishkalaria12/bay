// Records what the Expo app's store model does while its own test suite runs, as fixtures the Rust port must match:
//   node packages/mobile-core/scripts/record-store-fixtures.mjs
// A load hook wraps model.ts's exported functions; each call's input and output goes to fixtures/store.jsonl once
// (identical calls are kept once). The Rust tests in crates/bay-core/tests/store_fixtures.rs replay every line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "../fixtures/store.jsonl");
const WRAPPED = ["reduceBrowserData", "parseBrowserData", "persistedBrowserData", "mergeHistory", "parsePreferences", "parseSiteSetting"];

if (process.env.BAY_RECORD_FILE) {
  // Inside a test process: wrap the model and append each call.
  const file = process.env.BAY_RECORD_FILE;
  globalThis.__bayRecord = (fn, args, run) => {
    const input = JSON.stringify(args);
    let line;

    try {
      const result = run();
      const same = args.length > 0 && result === args[0];
      line = { fn, args: JSON.parse(input), result: result === undefined ? null : JSON.parse(JSON.stringify(result)), same };
      appendFileSync(file, `${JSON.stringify(line)}\n`);

      return result;
    } catch (error) {
      appendFileSync(file, `${JSON.stringify({ fn, args: JSON.parse(input), error: String(error?.message ?? error) })}\n`);
      throw error;
    }
  };

  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);

      if (!url.endsWith("/src/store/model.ts")) return loaded;
      let source = String(loaded.source);

      for (const name of WRAPPED) {
        source = source.replace(`export function ${name}(`, `function __bay_${name}(`);
        source += `\nexport function ${name}(...args) { return globalThis.__bayRecord(${JSON.stringify(name)}, args, () => __bay_${name}(...args)); }\n`;
      }

      return { ...loaded, source };
    },
  });
} else {
  // The driver: run the Expo app's tests with this file imported, then keep each distinct call once.
  const app = join(here, "../../../apps/mobile");
  const raw = join(here, "../fixtures/store.raw.jsonl");
  rmSync(raw, { force: true });

  const run = spawnSync(
    process.execPath,
    ["--import", fileURLToPath(import.meta.url), "--test", "--test-concurrency=1", "tests/*.test.ts", join(here, "store-scenarios.test.ts")],
    {
      cwd: app,
      env: { ...process.env, BAY_RECORD_FILE: raw, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
    },
  );

  const summary = String(run.stdout)
    .split("\n")
    .filter((line) => /^# (pass|fail)/.test(line));

  console.log(summary.join("\n"));

  if (!existsSync(raw)) throw new Error(`no calls recorded (tests exited ${run.status})`);
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
  writeFileSync(output, `${lines.join("\n")}\n`);
  const counts = {};

  for (const line of lines) counts[JSON.parse(line).fn] = (counts[JSON.parse(line).fn] ?? 0) + 1;
  console.log(`tests exited ${run.status}; ${lines.length} distinct calls`, counts);
}
