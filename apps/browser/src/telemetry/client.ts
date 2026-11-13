// The app's telemetry: the consent, the queue, and the choice the user made.
//
// The delivery is in telemetry/service.ts: this module keeps what the app has decided to share and hands the sending
// to the service. The opt-out is plain and immediate: it changes the generation, stops the uploads in flight and
// clears the queue and the identity at once, without waiting for a delivery that may be running.
import { engineInfo } from "@bay/chromium";
import { sendService } from "../runtime/serviceClient";
import { platformWords } from "../lib/platformWords";
import { readDocument, saveDocument, systemInfo, writeDocument, type SystemInfo } from "@bay/desktop";
import { create } from "zustand";
import * as Effect from "effect/Effect";
import type { JsonValue } from "../lib/json";
import { EVENTS_SCOPE, LOGS_SCOPE, MAX_EVENTS, MAX_LOGS, TELEMETRY_QUEUE_DOC, TELEMETRY_REQUEST_LOG_DOC, TELEMETRY_STATE_DOC } from "./config";
import { eventRecord, logRecord, logsRequest, type OtlpLogRecord, type QueuedEvent } from "./otlp";
import { cleanProperties } from "./sanitize";
import { canSend, DiagnosticsService, type RequestLogEntry, type TelemetryConsole, type TelemetryQueueView } from "./service";

export type { RequestLogEntry } from "./service";

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

    // SAFETY: JSON.parse yields the persisted telemetry document shape written by writeDocument for this name.
    return json ? (JSON.parse(json) as T) : null;
  } catch {
    return null;
  }
}

let saved: Saved = { ...DEFAULT };

// The documents' revision: it moves when the choice or the queue is written. A checkpoint writes what is current,
// and writes again when the app changed while it was writing.
let documentRevision = 0;

// The quit's attempts: a checkpoint that belongs to an older attempt is not the answer any more.
let quitGeneration = 0;

// The delivery is held while the app is quitting: what is queued stays queued, and nothing goes out.
let suspended = false;

// The checkpoint of the last attempt: the same promise while it is pending, and a new one when the documents moved.
let quitCheckpoint: Promise<void> | null = null;
let quitCheckpointPending = false;
let acknowledgedRevision = -1;

// The writes of the last checkpoint, so a later one waits for them.
let checkpointWrites: Promise<void> = Promise.resolve();

// The generation the running delivery started with: a result from a delivery the user has opted out of is not
// written down.
let deliveryGeneration = 0;

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

export interface TelemetryContext {
  [attribute: string]: string | number | boolean | null;
}

function context(): TelemetryContext {
  const info = appInfo();

  return {
    $lib: "bay-telemetry",
    $lib_version: "1",
    $app_name: "Bay",
    $app_version: info.appVersion,
    $app_build: info.appBuild,
    $os: platformWords.osName,
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

// The queue's generation. It moves when the user turns sharing off, and whatever was in flight belongs to the
// generation it started in.
let generation = 0;

let persistTimer: ReturnType<typeof setTimeout> | undefined;

function persistQueue(now = false) {
  documentRevision++;
  clearTimeout(persistTimer);
  persistTimer = undefined;

  // While the app is quitting, the queue is written by the checkpoint and not by a timer.
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
  persistQueue(true);
  changed();
}

let droppedWhileOff = 0;

export type CaptureOptions = {
  raw?: Record<string, JsonValue>;
  urgent?: boolean;
  persist?: boolean;
};

// MARK: What the service sees

// The uploads in flight: the opt-out stops them, without waiting for the delivery that is running.
const inflight = new Set<() => void>();

// The requests that were sent, for the app's own diagnostics.
const requests: RequestLogEntry[] = [];

export const requestLog = (): readonly RequestLogEntry[] => requests;

// The listeners the schedule hears from: the queue changed, so the grid may have work to do.
const listeners = new Set<() => void>();

const changed = () => {
  for (const listener of listeners) listener();
};

// A request that went out, written down so the app can show what was sent.
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

function resource(): TelemetryContext {
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

const events: TelemetryQueueView<QueuedEvent> = {
  kind: "events",
  take: () => queue.events,
  body: (batch) => eventsBody(batch),
  remove: (batch) => {
    queue.events = queue.events.filter((e) => !batch.includes(e));

    // The queue is smaller now: the grid may have nothing left to do.
    changed();
  },
};

const logs: TelemetryQueueView<OtlpLogRecord> = {
  kind: "logs",
  take: () => queue.logs,
  body: (batch) => logsBody(batch),
  remove: (batch) => {
    queue.logs = queue.logs.filter((l) => !batch.includes(l));

    changed();
  },
};

// The queue the app left on disk, as it was written.
function parseQueue(contents: string): Queue | null {
  try {
    // SAFETY: JSON.parse yields the queue document shape written by persistQueue for this name.
    const stored = JSON.parse(contents) as Partial<Queue>;

    if (stored.version !== 1) return null;

    return { version: 1, events: stored.events ?? [], logs: stored.logs ?? [] };
  } catch {
    return null;
  }
}

// The queue the service sends, as the app's own code keeps it. It is exported so the service's tests can drive the
// real thing.
export const telemetryConsole: TelemetryConsole = {
  // While the app is quitting, the delivery holds: the service asks the console, and the console says no.
  sharing: () => saved.sharing && !suspended,
  // The service reads the generation when a delivery starts, and again when it checks whether it is still current.
  generation: () => {
    deliveryGeneration = generation;

    return generation;
  },
  events,
  logs,
  inflight,
  recorded: (entry, body) => {
    // A result from a delivery that belongs to a choice the user has already changed is not written down.
    if (deliveryGeneration !== generation) return;

    logRequest(entry, body);
  },
  serialized: () => JSON.stringify(queue),
  restore: (contents) => {
    // Nothing that was queued before the user opted out comes back.
    if (!saved.sharing) return;

    const stored = parseQueue(contents);

    if (!stored) return;

    queue = { version: 1, events: [...stored.events, ...queue.events], logs: [...stored.logs, ...queue.logs] };
    changed();
  },
  subscribe: (listener) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  },
};

// MARK: Sending

// The desktop runtime is reached when there is something to send. The import is a promise on purpose: the runtime's
// own diagnostics reach this module (the consent gate is here), and a static import would close that loop.
const desktop = () => import("../effect/runtime");

// The delivery is the service's work: the app asks, and the service sends on the app's shared grid.
const startDelivery = async () => {
  const { runDesktop } = await desktop();

  await runDesktop(
    Effect.gen(function* () {
      const diagnostics = yield* DiagnosticsService;

      yield* diagnostics.start(telemetryConsole);
    }),
  ).catch(() => {});
};

const deliver = async () => {
  const { runDesktop } = await desktop();

  await runDesktop(
    Effect.gen(function* () {
      const diagnostics = yield* DiagnosticsService;

      yield* diagnostics.start(telemetryConsole);
      yield* diagnostics.deliver();
    }),
  ).catch(() => {});
};

export function capture(event: string, props: Record<string, JsonValue> = {}, options: CaptureOptions = {}) {
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
    changed();

    // A fatal error has to go out before the app goes down.
    if (options.urgent) void deliver();
  } catch {}
}

export function queueLog(level: "warn" | "error", message: string, attributes: Record<string, string | number | boolean>) {
  if (!saved.sharing) return;

  try {
    queue.logs.push(logRecord(level, message, attributes));

    if (queue.logs.length > MAX_LOGS) queue.logs.splice(0, queue.logs.length - MAX_LOGS);
    persistQueue();
    changed();
  } catch {}
}

/** Sends the queue now, and waits for the batches that went out. */
export async function flush() {
  await deliver();
}

// MARK: The user's choice

export type SharingSource = "settings" | "onboarding" | "ask";

export function setSharing(on: boolean, source: SharingSource) {
  if (sendService("telemetrySetSharing", [on, source])) return;
  const now = Date.now();

  if (on === saved.sharing) return save({ decidedAt: now, askDoneAt: saved.askDoneAt ?? now });

  // The queue belongs to the choice that has just changed: what is in flight stops, and what is waiting is gone.
  generation++;

  if (!on) {
    for (const stop of inflight) stop();
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
    sessionOpen: true,
    decidedAt: now,
    askDoneAt: saved.askDoneAt ?? now,
  });
  capture("sharing_turned_on", { source });
  void startDelivery();
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
  suspended = false;
  void engineInfo()
    .then((e) => (engineVersion = `NNCore / Chromium ${e.chromiumVersion}`))
    .catch(() => {});

  if (!saved.sharing) {
    const stale = readJson<Queue>(TELEMETRY_QUEUE_DOC);

    if (stale?.events?.length || stale?.logs?.length) clearQueue();

    return null;
  }

  const previous: PreviousSession = saved.lastVersion === null ? "none" : saved.sessionOpen ? "unclean" : "clean";
  const version = appInfo().appVersion;
  const updatedFrom = saved.lastVersion && saved.lastVersion !== version ? saved.lastVersion : null;
  save({ sessionOpen: true, lastVersion: version });

  // The delivery starts: the queue the app left on disk is merged in, and the grid takes the queue from here.
  void startDelivery();

  return { previous, updatedFrom };
}

/** Holds the delivery: nothing goes out, and what is in flight is stopped. */
function suspend() {
  suspended = true;
  // The queue belongs to the choice that has changed: what is in flight is not sent.
  generation++;

  for (const stop of inflight) stop();
  inflight.clear();

  clearTimeout(persistTimer);
  persistTimer = undefined;
}

/**
 * The quit checkpoint: the choice and the queue are written to disk, and the app waits for the answer. The answer
 * never waits for the network: what is saved is saved.
 */
function checkpointDocuments(attempt: number): Promise<void> {
  const writing = checkpointWrites.then(async () => {
    while (attempt === quitGeneration) {
      const revision = documentRevision;

      // Both documents are written, even when one of them fails: a later attempt cannot race the half that landed.
      const results = await Promise.allSettled([
        saveDocument(TELEMETRY_STATE_DOC, JSON.stringify(saved)),
        saveDocument(TELEMETRY_QUEUE_DOC, JSON.stringify(queue)),
      ]);

      const failed = results.find((result) => result.status === "rejected");

      if (failed?.status === "rejected") throw failed.reason;

      // Nothing changed while the documents were written: they are what the app quits with.
      if (attempt === quitGeneration && revision === documentRevision) {
        acknowledgedRevision = revision;

        return;
      }
    }
  });

  checkpointWrites = writing.catch(() => {});

  return writing;
}

/** Ends the session: the delivery holds and the choice and the queue are written to disk. */
export function endSession(): Promise<void> {
  if (quitCheckpoint && (quitCheckpointPending || acknowledgedRevision === documentRevision)) return quitCheckpoint;

  if (!suspended) {
    suspend();
    quitGeneration++;

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

/** Stops a retired coordinator's client: nothing goes out, and what is in flight is stopped. */
export function stopClient() {
  suspend();
  // The checkpoints of a client that is gone are not the app's answer any more.
  quitGeneration++;
}

/** The quit was called off: the delivery goes on with what is queued. */
export function resumeClientAfterQuit(): Promise<void> {
  if (!suspended) return checkpointWrites;

  suspended = false;
  quitCheckpoint = null;
  quitCheckpointPending = false;
  const attempt = ++quitGeneration;

  if (saved.sharing) save({ sessionOpen: true });
  persistQueue(true);

  // The current choice and the current queue are written once the older checkpoint has settled: opting out meanwhile
  // must keep its empty queue, and no snapshot is put back. The queue goes out again on the service's own grid.
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
