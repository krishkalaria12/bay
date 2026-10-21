import { sendService } from "../runtime/serviceClient";
import { isMac } from "@bay/platform";
import { engineInfo } from "@bay/nncore";
import { launchEnvironment, readDocument, saveDocument, systemInfo, writeDocument, type SystemInfo } from "@bay/shell";
import { create } from "zustand";
import {
  BATCH_SIZE,
  DEV_SEND_ENV,
  EVENTS_SCOPE,
  FLUSH_DELAY_MS,
  LOGS_SCOPE,
  LOGS_URL,
  MAX_BACKOFF_MS,
  MAX_BODY_BYTES,
  MAX_EVENTS,
  MAX_LOGS,
  TELEMETRY_QUEUE_DOC,
  TELEMETRY_REQUEST_LOG_DOC,
  TELEMETRY_STATE_DOC,
  URGENT_FLUSH_DELAY_MS,
} from "./config";
import { eventRecord, logRecord, logsRequest, outcome, type OtlpLogRecord, type QueuedEvent } from "./otlp";
import { cleanProperties } from "./sanitize";

// Send only with opt-in; never sync the choice.

type Saved = {
  version: 1;
  sharing: boolean;
  decidedAt: number | null;
  askDoneAt: number | null;
  installId: string | null;
  crashCursor: number;
  lastVersion: string | null;
  sessionOpen: boolean;
};

const DEFAULT: Saved = {
  version: 1,
  sharing: false,
  decidedAt: null,
  askDoneAt: null,
  installId: null,
  crashCursor: 0,
  lastVersion: null,
  sessionOpen: false,
};

function readJson<T>(name: string): T | null {
  try {
    const json = readDocument(name);
    return json ? (JSON.parse(json) as T) : null;
  } catch {
    return null;
  }
}

let saved: Saved = { ...DEFAULT };
let documentRevision = 0;
let quitGeneration = 0;
let suspended = false;
let quitCheckpoint: Promise<void> | null = null;
let quitCheckpointPending = false;
let acknowledgedRevision = -1;
// Serialize acknowledged checkpoints and cancellation repairs, even if the
// previous attempt failed or was cancelled while its disk writes were pending.
let checkpointWrites: Promise<void> = Promise.resolve();

function save(patch: Partial<Saved>) {
  saved = { ...saved, ...patch };
  documentRevision++;
  try {
    writeDocument(TELEMETRY_STATE_DOC, JSON.stringify(saved));
  } catch {}
  useTelemetry.setState({ sharing: saved.sharing, decided: saved.decidedAt !== null, askDone: saved.askDoneAt !== null });
}

export const useTelemetry = create<{ sharing: boolean; decided: boolean; askDone: boolean }>(() => ({
  sharing: false,
  decided: false,
  askDone: false,
}));

export const isSharing = () => saved.sharing;

// MARK: Context sent with every event

let app: SystemInfo | null = null;
export const appInfo = () => (app ??= systemInfo());
let engineVersion: string | null = null;

export const environment = (): "dev" | "test" | "production" => (__DEV__ ? "dev" : appInfo().isolatedInstance ? "test" : "production");

const devSendAllowed = () => launchEnvironment(DEV_SEND_ENV) === "1";
const canSend = () => !__DEV__ || devSendAllowed();

function context(): Record<string, unknown> {
  const info = appInfo();
  return {
    $lib: "bay-telemetry",
    $lib_version: "1",
    $app_name: "Bay",
    $app_version: info.appVersion,
    $app_build: info.appBuild,
    $os: isMac ? "macOS" : "Windows",
    $os_version: info.osVersion,
    arch: info.arch,
    engine_version: engineVersion,
    $environment: environment(),
    $process_person_profile: false,
    $geoip_disable: true,
  };
}

// MARK: Queue

type Queue = { version: 1; events: QueuedEvent[]; logs: OtlpLogRecord[] };

let queue: Queue = { version: 1, events: [], logs: [] };
let generation = 0;

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistQueue(now = false) {
  documentRevision++;
  clearTimeout(persistTimer);
  persistTimer = undefined;
  if (suspended && !now) return;
  const write = () => {
    try {
      writeDocument(TELEMETRY_QUEUE_DOC, JSON.stringify(queue));
    } catch {}
  };
  if (now) write();
  else persistTimer = setTimeout(write, 2000);
}

function clearQueue() {
  queue = { version: 1, events: [], logs: [] };
  clearTimeout(flushTimer);
  flushTimer = undefined;
  persistQueue(true);
}

let droppedWhileOff = 0;

export type CaptureOptions = {
  raw?: Record<string, unknown>;
  urgent?: boolean;
  persist?: boolean;
};

export function capture(event: string, props: Record<string, unknown> = {}, options: CaptureOptions = {}) {
  if (!saved.sharing || !saved.installId) {
    droppedWhileOff++;
    return;
  }
  try {
    queue.events.push({
      uuid: uuidv7(),
      event,
      distinct_id: saved.installId,
      timestamp: new Date().toISOString(),
      properties: { ...context(), ...cleanProperties(props), ...options.raw },
    });
    if (queue.events.length > MAX_EVENTS) queue.events.splice(0, queue.events.length - MAX_EVENTS);
    persistQueue(options.persist);
    scheduleFlush(options.urgent ? URGENT_FLUSH_DELAY_MS : FLUSH_DELAY_MS);
  } catch {}
}

export function queueLog(level: "warn" | "error", message: string, attributes: Record<string, string | number | boolean>) {
  if (!saved.sharing) return;
  try {
    queue.logs.push(logRecord(level, message, attributes));
    if (queue.logs.length > MAX_LOGS) queue.logs.splice(0, queue.logs.length - MAX_LOGS);
    persistQueue();
    scheduleFlush(FLUSH_DELAY_MS);
  } catch {}
}

// MARK: Sending

let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushDueAt = 0;
let flushing = false;
let failures = 0;
let retryAt = 0;

function scheduleFlush(delay: number) {
  if (!saved.sharing || suspended) return;
  const due = Math.max(Date.now() + delay, retryAt);
  if (flushTimer && flushDueAt <= due) return;
  clearTimeout(flushTimer);
  flushDueAt = due;
  flushTimer = setTimeout(() => void flush(), due - Date.now());
}

export type RequestLogEntry = {
  at: string;
  kind: "events" | "logs";
  url: string;
  count: number;
  bytes: number;
  status: number | null;
  dryRun?: boolean;
};

const requests: RequestLogEntry[] = [];

export const requestLog = (): readonly RequestLogEntry[] => requests;

function logRequest(entry: RequestLogEntry, body: string) {
  requests.push(entry);
  if (requests.length > 200) requests.shift();
  if (__DEV__) {
    try {
      const line = JSON.stringify({ ...entry, body: JSON.parse(body) });
      writeDocument(TELEMETRY_REQUEST_LOG_DOC, (readDocument(TELEMETRY_REQUEST_LOG_DOC) ?? "").slice(-400_000) + `${line}\n`);
    } catch {}
  }
  if (__DEV__) console.log(`[telemetry] ${entry.dryRun ? "dry run" : "POST"} ${entry.url} ${entry.kind}×${entry.count} → ${entry.status}`);
}

// Uploads in flight, so turning sharing off can stop them mid-request.
const inflight = new Set<AbortController>();

async function post(kind: RequestLogEntry["kind"], url: string, body: string, count: number, gen: number) {
  const entry: RequestLogEntry = { at: new Date().toISOString(), kind, url, count, bytes: body.length, status: null };
  if (!canSend()) {
    logRequest({ ...entry, dryRun: true }, body);
    return 200;
  }
  const abort = new AbortController();
  inflight.add(abort);
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: abort.signal });
    entry.status = response.status;
  } catch {
    entry.status = 0;
  } finally {
    inflight.delete(abort);
  }
  if (gen === generation) logRequest(entry, body);
  return entry.status;
}

function resource(): Record<string, unknown> {
  const info = appInfo();
  return {
    "service.name": "bay-app",
    "service.version": info.appVersion,
    "deployment.environment": environment() === "production" ? "production" : "development",
    "os.type": "darwin",
    "os.version": info.osVersion,
    "host.arch": info.arch,
    "engine.version": engineVersion,
  };
}

const eventsBody = (batch: QueuedEvent[]) =>
  logsRequest(
    resource(),
    EVENTS_SCOPE,
    batch.map((e) =>
      eventRecord(e.properties.engine_version == null && engineVersion ? { ...e, properties: { ...e.properties, engine_version: engineVersion } } : e),
    ),
  );

const logsBody = (batch: OtlpLogRecord[]) => logsRequest(resource(), LOGS_SCOPE, batch);

// Sends the head of a queue in batches until it's empty or the server says to retry later.
type DrainResult = "done" | "failed" | "stale";

async function drain<T>(
  kind: RequestLogEntry["kind"],
  take: () => T[],
  encode: (batch: T[]) => string,
  remove: (batch: T[]) => void,
  gen: number,
): Promise<DrainResult> {
  let size = BATCH_SIZE;
  for (let batch = take().slice(0, size); batch.length; batch = take().slice(0, size)) {
    if (gen !== generation || suspended) return "stale";
    const body = encode(batch);
    if (body.length > MAX_BODY_BYTES && batch.length > 1) {
      size = Math.ceil(batch.length / 2);
      continue;
    }
    const status = await post(kind, LOGS_URL, body, batch.length, gen);
    if (gen !== generation) return "stale";
    const result = outcome(status, batch.length);
    if (result === "retry") return "failed";
    if (result === "split") size = Math.ceil(batch.length / 2);
    else remove(batch);
  }
  return "done";
}

export async function flush() {
  flushTimer = undefined;
  if (!saved.sharing || flushing || suspended) return;
  flushing = true;
  const gen = generation;
  let result: DrainResult;
  try {
    result = await drain(
      "events",
      () => queue.events,
      eventsBody,
      (batch) => (queue.events = queue.events.filter((e) => !batch.includes(e))),
      gen,
    );
    if (result === "done")
      result = await drain(
        "logs",
        () => queue.logs,
        logsBody,
        (batch) => (queue.logs = queue.logs.filter((l) => !batch.includes(l))),
        gen,
      );
  } finally {
    if (gen === generation) flushing = false;
  }
  if (result === "stale" || gen !== generation) return;
  persistQueue(true);
  if (result === "failed") {
    failures++;
    retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (failures - 1));
    scheduleFlush(0);
  } else {
    failures = 0;
    retryAt = 0;
  }
}

// MARK: The user's choice

export type SharingSource = "settings" | "onboarding" | "ask";

export function setSharing(on: boolean, source: SharingSource) {
  if (sendService("telemetrySetSharing", [on, source])) return;
  const now = Date.now();
  if (on === saved.sharing) return save({ decidedAt: now, askDoneAt: saved.askDoneAt ?? now });
  generation++;
  flushing = false;
  failures = 0;
  retryAt = 0;
  if (!on) {
    for (const abort of inflight) abort.abort();
    inflight.clear();
    save({ sharing: false, installId: null, sessionOpen: false, decidedAt: now, askDoneAt: saved.askDoneAt ?? now });
    clearQueue();
    return;
  }
  save({
    sharing: true,
    installId: uuidv4(),
    crashCursor: now,
    lastVersion: appInfo().appVersion,
    sessionOpen: !suspended,
    decidedAt: now,
    askDoneAt: saved.askDoneAt ?? now,
  });
  capture("sharing_turned_on", { source });
}

export const dismissAsk = () => {
  if (!sendService("telemetryDismissAsk")) save({ askDoneAt: Date.now() });
};

// MARK: Lifecycle

export type PreviousSession = "clean" | "unclean" | "none";

let loaded = false;

export function loadChoice() {
  if (loaded) return;
  loaded = true;
  saved = { ...DEFAULT, ...readJson<Partial<Saved>>(TELEMETRY_STATE_DOC) };
  useTelemetry.setState({ sharing: saved.sharing, decided: saved.decidedAt !== null, askDone: saved.askDoneAt !== null });
}

export function startClient(): { previous: PreviousSession; updatedFrom: string | null } | null {
  loadChoice();
  void engineInfo()
    .then((e) => (engineVersion = `NNCore / Chromium ${e.chromiumVersion}`))
    .catch(() => {});
  if (!saved.sharing) {
    const stale = readJson<Queue>(TELEMETRY_QUEUE_DOC);
    if (stale?.events?.length || stale?.logs?.length) clearQueue();
    return null;
  }
  const stored = readJson<Queue>(TELEMETRY_QUEUE_DOC);
  if (stored?.version === 1) queue = { version: 1, events: [...(stored.events ?? []), ...queue.events], logs: [...(stored.logs ?? []), ...queue.logs] };
  const previous: PreviousSession = saved.lastVersion === null ? "none" : saved.sessionOpen ? "unclean" : "clean";
  const version = appInfo().appVersion;
  const updatedFrom = saved.lastVersion && saved.lastVersion !== version ? saved.lastVersion : null;
  save({ sessionOpen: true, lastVersion: version });
  scheduleFlush(10_000);
  return { previous, updatedFrom };
}

/** Stop a retired coordinator without marking a crashed session as clean. */
export function stopClient() {
  suspended = true;
  generation++;
  quitGeneration++;
  clearTimeout(flushTimer);
  clearTimeout(persistTimer);
  flushTimer = persistTimer = undefined;
  for (const abort of inflight) abort.abort();
}

function checkpointDocuments(attempt: number): Promise<void> {
  const writing = checkpointWrites.then(async () => {
    while (attempt === quitGeneration) {
      const revision = documentRevision;
      // Wait for both writes even on failure, so a later attempt cannot race
      // the successful half of an older checkpoint.
      const results = await Promise.allSettled(
        [TELEMETRY_STATE_DOC, TELEMETRY_QUEUE_DOC].map(async (name) => {
          await saveDocument(name, JSON.stringify(name === TELEMETRY_STATE_DOC ? saved : queue));
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (attempt === quitGeneration && revision === documentRevision) {
        acknowledgedRevision = revision;
        return;
      }
    }
  });
  checkpointWrites = writing.catch(() => {});
  return writing;
}

export function endSession(): Promise<void> {
  if (quitCheckpoint && (quitCheckpointPending || acknowledgedRevision === documentRevision)) return quitCheckpoint;
  if (!suspended) {
    suspended = true;
    generation++;
    quitGeneration++;
    flushing = false;
    for (const abort of inflight) abort.abort();
    inflight.clear();
    clearTimeout(flushTimer);
    flushTimer = undefined;
    clearTimeout(persistTimer);
    persistTimer = undefined;
    if (saved.sharing) save({ sessionOpen: false });
  }
  const checkpoint = checkpointDocuments(quitGeneration);
  quitCheckpoint = checkpoint;
  quitCheckpointPending = true;
  const settled = () => {
    if (quitCheckpoint === checkpoint) quitCheckpointPending = false;
  };
  void checkpoint.then(settled, settled);
  return quitCheckpoint;
}

export function resumeClientAfterQuit(): Promise<void> {
  if (!suspended) return checkpointWrites;
  suspended = false;
  quitCheckpoint = null;
  quitCheckpointPending = false;
  const attempt = ++quitGeneration;
  if (saved.sharing) save({ sessionOpen: true });
  persistQueue(true);
  scheduleFlush(FLUSH_DELAY_MS);
  // Re-save the current choice and queue after any old checkpoint settles.
  // Never restore a snapshot: opting out meanwhile must keep its empty queue.
  return checkpointDocuments(attempt);
}

export const crashCursor = () => saved.crashCursor;
export const advanceCrashCursor = (to: number) => to > saved.crashCursor && save({ crashCursor: to });

export const devState = () => ({ saved, queued: { events: queue.events.length, logs: queue.logs.length }, droppedWhileOff, canSend: canSend() });

// MARK: Ids

function hex(n: number) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}
function variant() {
  return (8 + Math.floor(Math.random() * 4)).toString(16);
}

export function uuidv4() {
  const h = hex(29);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-${variant()}${h.slice(15, 18)}-${h.slice(18, 29)}${hex(1)}`;
}

export function uuidv7() {
  const ms = Date.now().toString(16).padStart(12, "0");
  const h = hex(18);
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${h.slice(0, 3)}-${variant()}${h.slice(3, 6)}-${h.slice(6, 18)}`;
}
