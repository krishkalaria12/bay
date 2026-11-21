#!/usr/bin/env node
// Profiles Bay on Windows and Linux, and the local web preview: records a Chrome trace of everything performance work
// reads, and reports what it holds. See docs/profiling.md.
//
//   trace.mjs record [--seconds N] [--out FILE] [--port N | --ws URL | --data-dir DIR]
//       Records the running Bay over its DevTools endpoint (Settings › "Let the bay command control Bay"), or any
//       Chromium started with --remote-debugging-port. Stops after --seconds, or when you press Enter.
//   trace.mjs report TRACE [--top N] [--json FILE]
//       Reads a trace from `record`, from Help › Record Performance Issue (Downloads/Bay Trace *.json) or from a
//       --trace-startup launch, and prints where the time went. --json also writes the numbers, for `compare`.
//   trace.mjs compare BEFORE.json AFTER.json
//       Two --json reports side by side: what got faster, what got slower.
//   trace.mjs startup-flags [--seconds N] [--out FILE]
//       Prints the switches that trace a launch from its first moment.
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { MEMORY_DUMPS, TRACE_BUFFER_KB, TRACE_CATEGORIES, startupCategories } from "./traceConfig.mjs";
import { compareReports, formatComparison, formatReport, readTrace, reportTrace } from "./traceReport.mjs";

// MARK: CDP

/** A browser-level DevTools connection: commands, and their events by method. */
async function connect(ws) {
  const socket = new WebSocket(ws);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  // Node's WebSocket doesn't keep the process alive while it waits on Chrome.
  const alive = setInterval(() => {}, 1 << 30);

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`Couldn't connect to ${ws.replace(/token=[^&]+/, "token=…")}`)), { once: true });
  });

  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));

    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);

      if (data.error) reject(new Error(`${data.error.message} (${data.error.code})`));
      else resolve(data.result);
    } else if (data.method) for (const listener of listeners.get(data.method) ?? []) listener(data.params, data.sessionId);
  });

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const message = { id, method, params };

      // A command for an attached target names its session.
      if (sessionId) message.sessionId = sessionId;
      socket.send(JSON.stringify(message));

      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);

      return () => listeners.get(method).delete(listener);
    },
    close() {
      clearInterval(alive);
      socket.close();
    },
  };
}

// Where the installed Bay keeps its data, as the bay command finds it (apps/cli/src/endpoint.ts).
function dataRoot(dataDir) {
  const root = dataDir || process.env.BAY_DATA_DIR;

  if (root) return resolve(root.replace(/^~(?=$|\/)/, homedir()));

  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Bay", "User Data");

  if (process.platform === "linux") return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "bay");

  return join(homedir(), "Library", "Application Support", "in.krishkalaria.bay", "Chromium");
}

async function endpoint({ ws, port, dataDir }) {
  if (ws) return ws;

  if (port) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

    return version.webSocketDebuggerUrl;
  }

  const file = join(dataRoot(dataDir), "BayControl.json");

  if (!existsSync(file)) throw new Error(`${file} doesn't exist: start Bay and turn on Settings › "Let the bay command control Bay", or pass --port.`);
  const control = JSON.parse(readFileSync(file, "utf8"));

  return `ws://127.0.0.1:${control.port}${control.browser}?token=${encodeURIComponent(control.token)}`;
}

// The local preview has no engine to tell its document a trace started; Bay's own documents hear it from the engine.
async function toggleDocuments(cdp, on) {
  const { targetInfos } = await cdp.send("Target.getTargets");

  for (const target of targetInfos) {
    if (target.type !== "page" || !/^(chrome:\/\/bay\/|https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/])/.test(target.url)) continue;

    try {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      await cdp.send("Runtime.evaluate", { expression: `globalThis.bayProfiling?.${on ? "start" : "stop"}()` }, sessionId);
      await cdp.send("Target.detachFromTarget", { sessionId });
    } catch {}
  }
}

async function record({ seconds, out, ...where }) {
  const cdp = await connect(await endpoint(where));
  const file = resolve(out ?? `Bay Trace ${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  // Events arrive as Chrome writes them out at the end. (Over ReturnAsStream, IO.read never answered for a trace of a
  // few seconds with this list: Chrome 157, 2026-11-16.)
  const output = createWriteStream(file);
  let first = true;
  output.write('{"traceEvents":[');
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const event of value) {
      output.write(`${first ? "" : ",\n"}${JSON.stringify(event)}`);
      first = false;
    }
  });

  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      recordMode: "recordContinuously",
      traceBufferSizeInKb: TRACE_BUFFER_KB,
      includedCategories: TRACE_CATEGORIES,
      memoryDumpConfig: MEMORY_DUMPS,
    },
  });
  await toggleDocuments(cdp, true);
  console.error(seconds ? `Recording for ${seconds} s…` : "Recording. Reproduce the problem, then press Enter.");

  await new Promise((done) => {
    const lines = seconds ? null : createInterface({ input: process.stdin });
    const timer = seconds ? setTimeout(done, seconds * 1000) : null;
    lines?.once("line", () => (lines.close(), done()));
    process.once("SIGINT", () => (clearTimeout(timer), lines?.close(), done()));
  });

  await toggleDocuments(cdp, false);
  const complete = new Promise((done) => cdp.on("Tracing.tracingComplete", done));
  await cdp.send("Tracing.end");
  const { dataLossOccurred } = await complete;

  if (dataLossOccurred) console.error("The buffer filled: the trace keeps the newest part.");
  await new Promise((done) => output.end("]}\n", done));
  cdp.close();
  console.log(file);
}

// MARK: Commands

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string" },
    out: { type: "string" },
    port: { type: "string" },
    ws: { type: "string" },
    "data-dir": { type: "string" },
    top: { type: "string" },
    json: { type: "string" },
  },
});

const [command, ...files] = positionals;

switch (command) {
  case "record":
    await record({ seconds: values.seconds ? Number(values.seconds) : 0, out: values.out, ws: values.ws, port: values.port, dataDir: values["data-dir"] });
    break;
  case "report": {
    if (!files[0]) throw new Error("trace.mjs report TRACE");
    const report = reportTrace(await readTrace(files[0]), { top: values.top ? Number(values.top) : 20 });
    console.log(formatReport(report, files[0]));

    if (values.json) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(values.json, JSON.stringify(report.numbers, null, 1));
    }

    break;
  }

  case "compare": {
    if (files.length !== 2) throw new Error("trace.mjs compare BEFORE.json AFTER.json");
    const [before, after] = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
    console.log(formatComparison(compareReports(before, after)));

    break;
  }

  case "startup-flags": {
    const seconds = values.seconds ?? "30";
    const out = resolve(values.out ?? "bay-startup-trace.json");
    console.log(`--trace-startup=${startupCategories()} --trace-startup-duration=${seconds} --trace-startup-file=${out} --trace-startup-format=json`);

    break;
  }

  default:
    console.error("trace.mjs record | report TRACE | compare BEFORE.json AFTER.json | startup-flags (see the comment at the top)");
    process.exitCode = 1;
}
