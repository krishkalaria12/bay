import { listTasks, onExtensionsChanged } from "@bay/nncore";
import { useTranslate } from "../components/site/translate";
import { useBrowser } from "../store/browser";
import { useSync } from "../sync/engine";
import { capture, endSession, flush, isSharing, resumeClientAfterQuit, startClient, stopClient } from "./client";
import { reportNativeCrashes } from "./errors";
import { takeOmniboxLatency } from "./track";
import { EXTENSION_SETTLE_MS, FIRST_MEMORY_SAMPLE_MS } from "./config";

const HOUR_MS = 60 * 60_000;

const startedAt = Date.now();
let counts = { tabs: 0, windows: 0 };
let countsSince = Date.now();

function emitCounts() {
  if (isSharing() && (counts.tabs || counts.windows)) {
    capture("usage_counts", {
      tabs_opened: counts.tabs,
      windows_opened: counts.windows,
      period_minutes: Math.round((Date.now() - countsSince) / 60_000),
    });
  }
  counts = { tabs: 0, windows: 0 };
  countsSince = Date.now();
}

const size = (o: object) => Object.keys(o).length;

function watchStore() {
  return useBrowser.subscribe((s, prev) => {
    if (!isSharing()) return;
    if (s.tabs !== prev.tabs) counts.tabs += Math.max(0, size(s.tabs) - size(prev.tabs));
    if (s.windows !== prev.windows) {
      counts.windows += Math.max(0, size(s.windows) - size(prev.windows));
      for (const id in s.windows) {
        const w = s.windows[id]!;
        const before = prev.windows[id];
        if (before && before.spaceId !== w.spaceId && !w.incognito) profileSwitched(size(s.spaces));
      }
    }
    if (s.splits !== prev.splits) {
      for (const id in s.splits) if (!prev.splits[id]) capture("split_view_opened", { panes: s.splits[id]!.tabIds.length });
    }
    if (s.windowUi !== prev.windowUi) {
      for (const id in s.windowUi) if (s.windowUi[id]?.panel.open && !prev.windowUi[id]?.panel.open) capture("command_bar_opened");
    }
  });
}

function profileSwitched(profiles: number) {
  const start = Date.now();
  requestAnimationFrame(() => requestAnimationFrame(() => capture("profile_switched", { switch_ms: Date.now() - start, profiles })));
}

function watchSync() {
  let last = useSync.getState().status;
  return useSync.subscribe(({ status }) => {
    const was = last;
    last = status;
    if (was === status || !isSharing()) return;
    if (was === "off" && status !== "unavailable") capture("sync_toggled", { on: true });
    else if (status === "off" && was !== "unavailable") capture("sync_toggled", { on: false });
  });
}

function watchTranslate() {
  return useTranslate.subscribe((s, prev) => {
    if (!isSharing()) return;
    for (const tabId in s) if (s[tabId]?.status === "translating" && prev[tabId]?.status !== "translating") capture("translate_used");
  });
}

function watchExtensions() {
  const subscription = onExtensionsChanged((e) => {
    if (e.event === "installed" && Date.now() - startedAt > EXTENSION_SETTLE_MS) capture("extension_installed");
  });
  return () => subscription.remove();
}

// MARK: Performance

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

let usageGeneration = 0;
async function sampleMemory() {
  const generation = usageGeneration;
  if (!isSharing()) return;
  try {
    await listTasks();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const tasks = await listTasks();
    if (generation !== usageGeneration) return;
    let total = 0;
    let browser = 0;
    let gpu = 0;
    let renderers = 0;
    for (const t of tasks) {
      const m = Math.max(0, t.memory);
      total += m;
      if (t.type === "browser") browser += m;
      else if (t.type === "gpu") gpu += m;
      else if (t.type === "renderer") renderers++;
    }
    if (!total) return;
    capture("perf_memory", {
      total_mb: mb(total),
      browser_mb: mb(browser),
      gpu_mb: mb(gpu),
      renderer_processes: renderers,
      tabs: size(useBrowser.getState().tabs),
      uptime_hours: Math.round((Date.now() - startedAt) / HOUR_MS),
    });
  } catch {}
}

function emitOmniboxLatency() {
  const samples = takeOmniboxLatency().sort((a, b) => a - b);
  if (!samples.length || !isSharing()) return;
  const at = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
  capture("perf_omnibox", { samples: samples.length, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: samples.at(-1)! });
}

function hourly() {
  emitCounts();
  emitOmniboxLatency();
  void sampleMemory();
}

let stopUsage: (() => void) | undefined;
export function startUsage(): () => void {
  if (stopUsage) return stopUsage;
  usageGeneration++;
  const session = startClient();
  let crashes: ReturnType<typeof setTimeout> | undefined;
  if (session) {
    capture("app_launched", { previous_session: session.previous });
    if (session.updatedFrom) capture("app_updated", { from_version: session.updatedFrom });
    crashes = setTimeout(() => void reportNativeCrashes(), 5000);
  }
  const stops = [watchStore(), watchSync(), watchTranslate(), watchExtensions()];
  const sample = setTimeout(() => void sampleMemory(), FIRST_MEMORY_SAMPLE_MS);
  const interval = setInterval(hourly, HOUR_MS);
  const stop = () => {
    if (stopUsage !== stop) return;
    stopUsage = undefined;
    usageGeneration++;
    clearTimeout(crashes);
    clearTimeout(sample);
    clearInterval(interval);
    for (const remove of stops) remove();
    stopClient();
  };
  stopUsage = stop;
  return stop;
}

let quitPrepared = false;

export function prepareTelemetryForQuit(): Promise<void> {
  if (!quitPrepared) {
    quitPrepared = true;
    if (isSharing()) {
      emitCounts();
      emitOmniboxLatency();
      capture("app_session_ended", { duration_minutes: Math.round((Date.now() - startedAt) / 60_000) });
    }
  }
  return endSession();
}

export function resumeTelemetryAfterQuit(): Promise<void> {
  quitPrepared = false;
  return resumeClientAfterQuit();
}

export function sessionEnding() {
  void prepareTelemetryForQuit().catch((error) => console.warn("Couldn't checkpoint telemetry before quitting", error));
}

export async function devHourly() {
  hourly();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await flush();
}
