#!/usr/bin/env node
// WebGL shader benchmark for the Linux web host: the plan's performance gates for @bay/shaders on this machine's GPU.
// Runs tests/web/bench.html of packages/shaders in Chromium (the engine Bay's Linux build ships) and prints p50/p95.
//
//   node apps/browser/scripts/perf/shader-bench.mjs [--runs 3] [--headed 1] [--chromium <path>] [--json <file>]
//     --headed 1   a real Wayland/X11 window (vsync, the desktop compositor) instead of headless
//
// Gates (docs/shared-webgl-shaders-plan.html, 1920×1080 CSS px):
//   backdrop invalidation draw + copy p95 < 8 ms at DPR 1, after warmup
//   animation frame work p95 within 16.7 ms at DPR 1
//   no shader-caused main-thread task over 50 ms
// GPU time comes from EXT_disjoint_timer_query_webgl2 when the driver exposes it; missing GPU time is not zero cost.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { findChromium, withChromium } from "../../../../packages/shaders/scripts/browser.mjs";

const { values: opts } = parseArgs({
  options: { runs: { type: "string", default: "3" }, headed: { type: "string", default: "0" }, chromium: { type: "string" }, json: { type: "string" } },
});
const runs = Number(opts.runs);
const headed = opts.headed === "1";
const args = headed
  ? ["--ozone-platform-hint=auto", "--ignore-gpu-blocklist", "--window-size=1920,1080"]
  : ["--headless=new", "--use-angle=gl", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];

const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(2)} ms` : "n/a");

const scenarios = [
  { name: "startup (context, compile, link)", page: { query: "?scenario=startup", dpr: 1 } },
  { name: "backdrop ×1 · DPR 1", page: { query: "?scenario=backdrop&views=1", dpr: 1 }, gate: { key: "flush", p95: 8 } },
  { name: "backdrop ×3 · DPR 1", page: { query: "?scenario=backdrop&views=3", dpr: 1 }, gate: { key: "flush", p95: 8 } },
  { name: "backdrop ×1 · DPR 2", page: { query: "?scenario=backdrop&views=1", dpr: 2 } },
  { name: "PowerUp · DPR 1", page: { query: "?scenario=powerUp", dpr: 1 }, gate: { key: "work", p95: 16.7 } },
  { name: "PowerUp · DPR 2", page: { query: "?scenario=powerUp", dpr: 2 } },
  { name: "AreaLight · DPR 1", page: { query: "?scenario=areaLight", dpr: 1 }, gate: { key: "work", p95: 16.7 } },
];

const report = {};
let failed = false;
await withChromium({ browser: findChromium(opts.chromium), args }, async (open) => {
  for (const sc of scenarios) {
    const merged = {};
    let gpu = "";
    for (let r = 0; r < runs; r++) {
      const res = await open("bench.html", { width: 1920, height: 1080, ...sc.page });
      gpu = res.gpu;
      for (const [k, v] of Object.entries(res)) if (Array.isArray(v)) (merged[k] ??= []).push(...v);
      for (const k of ["first", "compile"]) if (typeof res[k] === "number") (merged[k] ??= []).push(res[k]);
    }
    report[sc.name] = { gpu, ...merged };
    const line = [`${sc.name}`];
    for (const k of ["context", "start", "poll", "linked", "first", "compile", "flush", "settled", "work", "gpuMs", "intervals"]) {
      if (!merged[k]?.length) continue;
      line.push(`${k} p50 ${ms(pct(merged[k], 50))} p95 ${ms(pct(merged[k], 95))}`);
    }
    if (merged.intervals?.length)
      line.push(`missed frames ${merged.intervals.filter((i) => i > 1.5 * pct(merged.intervals, 50)).length}/${merged.intervals.length}`);
    const long = (merged.longTasks ?? []).filter((d) => d > 50);
    line.push(`long tasks >50ms: ${long.length}${long.length ? ` (max ${ms(Math.max(...long))})` : ""}`);
    if (long.length) failed = true;
    if (sc.gate) {
      const v = pct(merged[sc.gate.key], 95);
      const ok = v < sc.gate.p95;
      if (!ok) failed = true;
      line.push(`gate ${sc.gate.key} p95 < ${sc.gate.p95} ms: ${ok ? "pass" : "FAIL"}`);
    }
    console.log(line.join("\n  "));
  }
  console.log(`GPU: ${Object.values(report)[0]?.gpu}`);
});
if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2));
process.exitCode = failed ? 1 : 0;
