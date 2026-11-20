#!/usr/bin/env node
// What the Windows/Linux window UI costs in Chromium: the built web app's localhost preview, seeded with js-bench's
// profile (seed.mjs: 200 tabs, 5000 history entries, 1000 bookmarks), in headless Chromium over the DevTools protocol.
// The preview runs the single-document entry, so this is a window's own work without the runtime's commits
// (runtime-bench.mjs measures those).
//
//   pnpm build:web && CHROMIUM=<chromium> node scripts/perf/web-bench.mjs [--platform windows|linux] [--rounds 3]
//
// Prints the start-up to the first tab rows (the first load compiles the bundle; later ones reuse V8's code cache),
// then for each interaction (a click on a tab row, a wheel over the sidebar, and two frames with no input as the
// floor) the renderer main thread's busy time per interaction from a trace and the trace events that took it by self
// time. One more untimed round of clicks gives React's commits and renders, the native calls, and where the renders
// start (a component that rendered under one that didn't).
//
//   --paths <n>              the components that rendered under each such start
//   --profile <file>         a V8 CPU profile of the interactions, and its heaviest functions (--top <n>)
//   --startup <n>            one more start-up, traced: the main thread's <n> heaviest trace events by self time
//   --startup-profile <file> a V8 CPU profile of that start-up
//   --dom 1                  the document's element counts: all, hidden, off-screen, and the busiest subtrees
//   --ancestors <n>          a tab row's <n> ancestors, with their attributes
//   --script <js>, --css <css>  an experiment, run or added once the app has drawn

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { findChromium } from "../../../../packages/shaders/scripts/browser.mjs";
import { buildSeed } from "./seed.mjs";

const flags = {};
const args = process.argv.slice(2);

for (let i = 0; i < args.length; i += 2) flags[args[i].replace(/^--/, "")] = args[i + 1];

const platform = flags.platform ?? "windows";
const rounds = Number(flags.rounds ?? 3);
const dist = fileURLToPath(new URL("../../dist", import.meta.url));

if (!existsSync(join(dist, "index.html"))) throw new Error("Nothing to run: pnpm build:web first");

const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".ttf": "font/ttf", ".woff2": "font/woff2" };

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
  const asked = normalize(join(dist, path));
  const file = asked.startsWith(dist) && existsSync(asked) && statSync(asked).isFile() ? asked : join(dist, "index.html");
  response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const origin = `http://localhost:${server.address().port}`;

const seed = buildSeed(origin);
const documents = Object.fromEntries(Object.entries(seed).map(([name, value]) => [name, JSON.stringify(value)]));
const titles = [...new Set(seed["session.json"].tabs.filter((tab) => tab.spaceId === "default").map((tab) => tab.title))];

const profileDir = mkdtempSync(join(tmpdir(), "bay-web-bench-"));

const chrome = spawn(
  findChromium(flags.chromium),
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--window-size=1440,900", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);

try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", (data) => {
      log += data;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(log);

      if (found) resolve(found[1]);
    });
    chrome.on("exit", () => reject(new Error(`Chromium exited:\n${log}`)));
  });

  const ws = new WebSocket(endpoint);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let next = 0;
  const waiting = new Map();
  const traceEvents = [];
  let traced;

  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);

    if (message.method === "Tracing.dataCollected") traceEvents.push(...message.params.value);

    if (message.method === "Tracing.tracingComplete") traced?.();

    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  });

  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => call(method, params, sessionId);

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });

    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? JSON.stringify(exceptionDetails));

    return result.value;
  };

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `globalThis.__bayPreviewDocuments = ${JSON.stringify(documents)}; globalThis.__bayPreviewCalls = {};`,
  });

  const frames = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";

  // The visible tab rows in the sidebar, by their titles: [title, x, y] for a click on each.
  const rows = `(() => {
    const titles = new Set(${JSON.stringify(titles)});
    const out = [];
    for (const el of document.querySelectorAll("div, span")) {
      if (el.childElementCount || !titles.has(el.textContent)) continue;
      const box = el.getBoundingClientRect();
      if (box.width && box.left < 420 && box.top > 60 && box.bottom < innerHeight - 20) out.push([el.textContent, box.left + Math.min(40, box.width / 2), box.top + box.height / 2]);
    }
    return out;
  })()`;

  const startups = [];

  for (let round = 0; round < rounds; round++) {
    await send("Page.navigate", { url: `${origin}/?platform=${platform}` });

    // From navigation start to the first frame with tab rows in the sidebar.
    const at = await evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 30000;
      const look = () => {
        if (/Bay could not start/.test(document.body?.innerText ?? "")) return reject(new Error(document.body.innerText));
        if (${rows}.length > 5) return requestAnimationFrame(() => resolve(performance.now()));
        if (performance.now() > deadline) return reject(new Error("no tab rows"));
        requestAnimationFrame(look);
      };
      look();
    })`);

    startups.push(at);
  }

  if (flags.startup) {
    // One more start-up, traced: where the renderer's main thread spent it, by trace event self time.
    await call("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: { includedCategories: ["toplevel", "devtools.timeline", "v8", "v8.execute", "blink", "loading"] },
    });

    if (flags["startup-profile"]) {
      await send("Profiler.enable");
      await send("Profiler.setSamplingInterval", { interval: 100 });
      await send("Profiler.start");
    }

    await send("Page.navigate", { url: `${origin}/?platform=${platform}` });
    await evaluate(
      `new Promise((resolve) => { const look = () => (${rows}.length > 5 ? requestAnimationFrame(resolve) : requestAnimationFrame(look)); look(); })`,
    );

    if (flags["startup-profile"]) writeFileSync(flags["startup-profile"], JSON.stringify((await send("Profiler.stop")).profile));
    const complete = new Promise((resolve) => (traced = resolve));
    await call("Tracing.end");
    await complete;
    const names = traceEvents.filter((event) => event.ph === "M" && event.name === "thread_name" && event.args.name === "CrRendererMain");

    const busiest = names
      .map(({ pid, tid }) => [
        pid,
        tid,
        traceEvents.filter((e) => e.pid === pid && e.tid === tid && e.name === "RunTask").reduce((sum, e) => sum + (e.dur ?? 0), 0),
      ])
      .sort((a, b) => b[2] - a[2])[0];

    const main = traceEvents.filter((e) => e.pid === busiest[0] && e.tid === busiest[1] && e.ph === "X").sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    console.log(`start-up, traced: the renderer's main thread busy ${(busiest[2] / 1000).toFixed(0)} ms; by self time:`);
    console.log(
      [...selfTimes(main)]
        .filter(([name]) => !/RunTask/.test(name))
        .sort((a, b) => b[1] - a[1])
        .slice(0, Number(flags.startup))
        .map(([name, micros]) => `${(micros / 1000).toFixed(1).padStart(7)} ms  ${name}`)
        .join("\n"),
    );
    traceEvents.length = 0;
  }

  await evaluate(`new Promise((r) => setTimeout(r, 1000))`);

  if (flags.ancestors) {
    // A tab row's ancestors, innermost first: their tags, attributes and child counts.
    console.log(
      await evaluate(`(() => {
        const titles = new Set(${JSON.stringify(titles)});
        let el = [...document.querySelectorAll("div, span")].find((e) => !e.childElementCount && titles.has(e.textContent));
        const out = [];
        for (let i = 0; el && i < Number(${JSON.stringify(flags.ancestors)}); i++, el = el.parentElement)
          out.push(el.tagName + " " + [...el.attributes].map((a) => a.name + "=" + a.value.slice(0, 60)).join(" ") + " children=" + el.childElementCount);
        return out.join("\\n");
      })()`),
    );
  }

  // An experiment's script, run once the app has drawn: --script "…".
  if (flags.script) await evaluate(flags.script);

  // An experiment's stylesheet, added once the app has drawn: --css "selector { … }".
  if (flags.css) await evaluate(`document.head.append(Object.assign(document.createElement("style"), { textContent: ${JSON.stringify(flags.css)} }))`);

  if (flags.dom) {
    // Where the document's elements are: the busiest subtrees, by element count.
    console.log(
      await evaluate(`(() => {
        const all = document.getElementsByTagName("*").length;
        const hidden = [...document.querySelectorAll("*")].filter((el) => el.getClientRects().length === 0).length;
        const offscreen = [...document.querySelectorAll("*")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth); }).length;
        const label = (el) => el.getAttribute("data-testid") || el.getAttribute("aria-label") || el.getAttribute("role") || el.className.toString().slice(0, 40) || el.tagName;
        const big = [...document.querySelectorAll("body *")].map((el) => [el, el.getElementsByTagName("*").length]).filter(([el, n]) => n > all / 20 && [...el.children].every((c) => c.getElementsByTagName("*").length < n * 0.9));
        return JSON.stringify({ all, hidden, offscreen, big: big.map(([el, n]) => label(el) + ": " + n).slice(0, 20) }, null, 1);
      })()`),
    );
  }

  if (flags.profile) {
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", { interval: 200 });
    await send("Profiler.start");
  }

  const targets = (await evaluate(rows)).slice(0, 24);

  if (targets.length < 4) throw new Error(`only ${targets.length} tab rows to click`);

  await call("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: { includedCategories: ["toplevel", "devtools.timeline", "blink.user_timing", "v8.execute", "blink", "cc"] },
  });

  const phases = { "idle 2 s": 0, "no input": 0, hover: 0, click: 0, wheel: 0 };

  const phase = async (name, run) => {
    await evaluate(`performance.mark("bench ${name} start")`);
    await run();
    await evaluate(`performance.mark("bench ${name} end")`);
  };

  // Two seconds of nothing, waited out with a timer, so only the app asks for frames: an idle window should draw none.
  await phase("idle 2 s", async () => {
    await evaluate(`new Promise((r) => setTimeout(r, 2000))`);
    phases["idle 2 s"] = 1;
  });

  // Two frames with no input: the floor under the others.
  await phase("no input", async () => {
    for (let round = 0; round < 20; round++, phases["no input"]++) await evaluate(frames);
  });

  const clickRows = async (onEach) => {
    for (const [, x, y] of targets) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await evaluate(frames);
      onEach();
    }
  };

  // The pointer moving down the rows, one row at a time: each move leaves one row and enters the next.
  await phase("hover", async () => {
    for (let round = 0; round < rounds; round++)
      for (const [, x, y] of targets) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 60, y });
        await evaluate(frames);
        phases.hover++;
      }
  });

  await phase("click", async () => {
    for (let round = 0; round < rounds; round++) await clickRows(() => phases.click++);
  });

  // One more round of clicks, untimed, with React's commits recorded: what rendered (web/reactProfiling.ts, on while bayProfiling is).
  await evaluate(`(() => {
    globalThis.benchCommits = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === "Bay.react commit") benchCommits.push(entry.detail);
    }).observe({ type: "measure" });
    globalThis.bayProfiling.start();

    // Where each commit's renders start: a component that rendered under one that didn't (its own state, a store or
    // a context changed), with the components that rendered under it.
    globalThis.benchRoots = new Map();
    const COMPONENTS = new Set([0, 1, 11, 14, 15]);
    const nameOf = (type) => !type ? "?" : typeof type === "string" ? type : type.displayName || type.name || nameOf(type.render ?? type.type);
    const rendered = (fiber) => COMPONENTS.has(fiber.tag) && (fiber.flags & 1 || !fiber.alternate);
    const owner = (fiber) => { let up = fiber.return; while (up && !COMPONENTS.has(up.tag)) up = up.return; return up; };
    const count = (fiber, names) => {
      let n = 0;
      const stack = [fiber.child].filter(Boolean);
      while (stack.length) {
        const f = stack.pop();
        if (rendered(f)) {
          n++;
          const path = nameOf(owner(f)?.type) + ">" + nameOf(f.type);
          names[path] = (names[path] ?? 0) + 1;
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child && (!f.alternate || f.child !== f.alternate.child)) stack.push(f.child);
      }
      return n;
    };
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const commit = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (...args) {
      commit.apply(this, args);
      if (!globalThis.bayProfiling.active) return;
      const stack = [args[1].current];
      while (stack.length) {
        const fiber = stack.pop();
        if (rendered(fiber) && fiber.alternate) {
          const parent = owner(fiber);
          if (parent && !rendered(parent)) {
            const key = nameOf(fiber.type) + " < " + nameOf(parent.type);
            const entry = benchRoots.get(key) ?? [0, 0, {}];
            entry[0]++;
            entry[1] += 1 + count(fiber, entry[2]);
            benchRoots.set(key, entry);
            if (fiber.sibling) stack.push(fiber.sibling);
            continue;
          }
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child && (!fiber.alternate || fiber.child !== fiber.alternate.child)) stack.push(fiber.child);
      }
    };
  })()`);

  let profiledClicks = 0;
  await evaluate(`globalThis.__bayPreviewCalls = {}`);

  // --react wheel: the profiled round wheels the sidebar instead (its numbers are then per wheel).
  if (flags.react === "wheel")
    for (let round = 0; round < 20; round++, profiledClicks++) {
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 150, y: 450, deltaX: 0, deltaY: round < 10 ? 240 : -240 });
      await evaluate(frames);
    }
  else await clickRows(() => profiledClicks++);
  const nativeCalls = await evaluate(`globalThis.__bayPreviewCalls`);
  const commits = await evaluate(`(globalThis.bayProfiling.stop(), benchCommits)`);
  const roots = await evaluate(`[...benchRoots]`);

  await phase("wheel", async () => {
    for (let round = 0; round < rounds * 10; round++, phases.wheel++) {
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 150, y: 450, deltaX: 0, deltaY: round % 20 < 10 ? 240 : -240 });
      await evaluate(frames);
    }
  });

  const complete = new Promise((resolve) => (traced = resolve));
  await call("Tracing.end");
  await complete;

  console.log(`${platform}: ${titles.length} titles, ${targets.length} rows clicked ${rounds}×`);
  // The first load compiles the bundle; later ones reuse V8's code cache, as chrome://bay does with WebUICodeCache.
  console.log(
    `start-up to tab rows: first ${startups[0].toFixed(0)} ms, then ${startups
      .slice(1)
      .map((ms) => ms.toFixed(0))
      .join(", ")} ms\n`,
  );
  console.log(busyByPhase(traceEvents, phases));

  const rendered = new Map();

  for (const { components } of commits)
    for (const part of components.split(",")) {
      const [name, count] = part.split(":");
      rendered.set(name, (rendered.get(name) ?? 0) + Number(count));
    }

  const renders = commits.reduce((sum, commit) => sum + commit.renders, 0);
  console.log(
    `\nclick: ${(commits.length / profiledClicks).toFixed(1)} React commits and ${(renders / profiledClicks).toFixed(0)} component renders each; most rendered:`,
  );
  console.log(
    [...rendered]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([name, count]) => `${name} ${(count / profiledClicks).toFixed(1)}`)
      .join(", "),
  );
  const callCount = Object.values(nativeCalls).reduce((sum, n) => sum + n, 0);
  console.log(
    `\nclick: ${(callCount / profiledClicks).toFixed(1)} native calls each: ${Object.entries(nativeCalls)
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => `${key} ${(n / profiledClicks).toFixed(1)}`)
      .join(", ")}`,
  );
  console.log(`\nwhere they start (component < the one above it that didn't render): times and renders under it, per click`);

  for (const [key, [times, under, names]] of roots.sort((a, b) => b[1][1] - a[1][1]).slice(0, 20)) {
    console.log(`${(under / profiledClicks).toFixed(1).padStart(7)} renders ${(times / profiledClicks).toFixed(1).padStart(5)}×  ${key}`);

    if (flags.paths)
      console.log(
        `          ${Object.entries(names)
          .sort((a, b) => b[1] - a[1])
          .slice(0, Number(flags.paths))
          .map(([path, n]) => `${path} ${(n / profiledClicks).toFixed(1)}`)
          .join(", ")}`,
      );
  }

  if (flags.profile) {
    const { profile } = await send("Profiler.stop");
    writeFileSync(flags.profile, JSON.stringify(profile));
    const self = new Map();
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const counts = new Map();

    profile.samples.forEach((id, index) => counts.set(id, (counts.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)));

    for (const [id, micros] of counts) {
      const { functionName, url, lineNumber } = nodes.get(id).callFrame;
      const key = `${functionName || "(anonymous)"} ${url.split("/").pop()}:${lineNumber}`;
      self.set(key, (self.get(key) ?? 0) + micros);
    }

    const total = [...self.values()].reduce((a, b) => a + b, 0);
    console.log(`\nprofile: ${flags.profile}, ${(total / 1000).toFixed(0)} ms sampled; heaviest by self time:`);

    for (const [key, micros] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(flags.top ?? 30)))
      console.log(`${(micros / 1000).toFixed(1).padStart(8)} ms ${((100 * micros) / total).toFixed(1).padStart(5)}%  ${key}`);
  }

  ws.close();
} finally {
  chrome.kill();
  server.close();
  await new Promise((resolve) => chrome.once("exit", resolve).once("error", resolve));
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** The renderer main thread's busy time per interaction in each phase, and the trace events that took it. */
function busyByPhase(events, counts) {
  const marks = events.filter((event) => event.cat?.includes("blink.user_timing") && event.name.startsWith("bench "));
  const { pid, tid } = marks[0] ?? {};
  const main = events.filter((event) => event.pid === pid && event.tid === tid && event.ph === "X").sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const lines = [];

  for (const [name, count] of Object.entries(counts)) {
    const start = marks.find((mark) => mark.name === `bench ${name} start`)?.ts;
    const end = marks.find((mark) => mark.name === `bench ${name} end`)?.ts;
    const within = main.filter((event) => event.ts >= start && event.ts + (event.dur ?? 0) <= end);

    const busy = within
      .filter((event) => event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask")
      .reduce((sum, event) => sum + event.dur, 0);

    const self = selfTimes(within);

    const top = [...self]
      .filter(([key]) => !/RunTask/.test(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([key, micros]) => `${key} ${(micros / 1000 / count).toFixed(2)}`)
      .join(", ");

    const frames = within.filter((event) => event.name === "FireAnimationFrame").length;
    // The tasks that ran animation frames, and what they took in all: the app's animations, which go on after a click.
    const tasks = within.filter((event) => /RunTask/.test(event.name));

    const animating = tasks.filter((task) =>
      within.some((event) => event.name === "FireAnimationFrame" && event.ts >= task.ts && event.ts < task.ts + task.dur),
    );

    const frameMs = animating.reduce((sum, task) => sum + task.dur, 0) / 1000;
    lines.push(
      `${name.padEnd(9)} ${(busy / 1000 / count).toFixed(2).padStart(6)} ms busy each (${count}), of it ${(frameMs / count).toFixed(2)} ms in ${(frames / count).toFixed(1)} animation frames  ${top}`,
    );
  }

  return lines.join("\n");
}

/** Each event's duration less its children's, summed by name, for one thread's complete events in time order. */
function selfTimes(events) {
  const self = new Map();
  const stack = [];

  for (const event of events) {
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= event.ts) stack.pop();
    const parent = stack.at(-1);

    if (parent) self.set(parent.name, (self.get(parent.name) ?? 0) - (event.dur ?? 0));
    self.set(event.name, (self.get(event.name) ?? 0) + (event.dur ?? 0));
    stack.push(event);
  }

  return self;
}
