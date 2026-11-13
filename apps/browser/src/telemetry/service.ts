// The app's telemetry: the queue it keeps, the delivery of it, and the consent that governs both.
//
// The consent gate and the queue are the app's own, plain and immediate (telemetry/client.ts): the app's code asks
// them synchronously, and a crash has to be recorded before the process dies. This module is the delivery: when the
// queue goes out, what it goes out in, and what happens when the user turns sharing off while a request is in
// flight.
//
// The service owns the schedule and the request fibers, so the delivery stops when the app does. The opt-out does
// not wait for either: it changes the generation, stops the uploads and empties the queue in the app's own code, and
// this service notices the generation has moved on and drops what it was holding.
import { launchEnvironment, readDocument, writeDocument } from "@bay/desktop";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { Operation } from "../effect/errors";
import { Diagnostics } from "../effect/ports/diagnostics";
import { Scheduler } from "../effect/ports/scheduler";
import { BATCH_SIZE, DEV_SEND_ENV, FLUSH_DELAY_MS, LOGS_URL, MAX_BACKOFF_MS, MAX_BODY_BYTES, TELEMETRY_QUEUE_DOC } from "./config";
import { outcome, type OtlpLogRecord, type QueuedEvent } from "./otlp";

// The collector is not waited for forever: the tries fit inside the deadline.
const UPLOAD_TIMEOUT_MS = 30_000;

// A network that is not there is worth two more tries, and no more.
const UPLOAD_RETRIES = 2;

// The wait before the first try again. The one after it is twice this.
const RETRY_DELAY_MS = 500;

// The wait before the next delivery after a failure. It doubles with every failure in a row, up to the cap in the
// telemetry's own settings.
const BACKOFF_BASE_MS = 30_000;

// MARK: The native and network side

/** The telemetry could not be sent, or could not be kept on disk. */
export class TelemetryError extends TaggedError("TelemetryError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** What the collector answered. */
export type TelemetryAnswer = {
  /** The status it answered with. */
  readonly status: number;
  /** Whether the batch was only written down, because this build does not send. */
  readonly dryRun: boolean;
  /** When it will take the batch again, if it said so. */
  readonly retryAfterMs?: number;
};

/** A batch to send, and the signal that stops it. */
export type TelemetryUpload = {
  readonly url: string;
  readonly body: string;
  /** Cancelled when the user turns sharing off. */
  readonly signal: AbortSignal;
};

/** The native and network side of the telemetry, as the service reaches it. */
export class TelemetryEngine extends Context.Service<
  TelemetryEngine,
  {
    /** Sends a batch to the collector. */
    readonly upload: (request: TelemetryUpload) => Effect.Effect<TelemetryAnswer, TelemetryError>;
    /** Reads the queue the app left on disk. */
    readonly readQueue: () => Effect.Effect<string | null, TelemetryError>;
    /** Writes the queue to disk. */
    readonly writeQueue: (contents: string) => Effect.Effect<void, TelemetryError>;
  }
>()("bay/TelemetryEngine") {
  static readonly layer = Layer.succeed(TelemetryEngine)({
    upload: (request) =>
      Effect.suspend(() => {
        // A development build only sends when it is asked to.
        if (!canSend()) return Effect.succeed<TelemetryAnswer>({ status: 200, dryRun: true });

        return Effect.tryPromise({
          try: (signal) =>
            fetch(request.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: request.body,
              signal: link(request.signal, signal),
            }).then((response) => ({ status: response.status, dryRun: false, retryAfterMs: retryAfter(response) })),
          catch: (cause) => new TelemetryError({ operation: { name: "telemetry.upload", resource: request.url }, cause }),
        });
      }),
    readQueue: () =>
      Effect.try({
        try: () => readDocument(TELEMETRY_QUEUE_DOC),
        catch: (cause) => new TelemetryError({ operation: { name: "telemetry.queue.read", resource: TELEMETRY_QUEUE_DOC }, cause }),
      }),
    writeQueue: (contents) =>
      Effect.try({
        try: () => writeDocument(TELEMETRY_QUEUE_DOC, contents),
        catch: (cause) => new TelemetryError({ operation: { name: "telemetry.queue.write", resource: TELEMETRY_QUEUE_DOC }, cause }),
      }),
  });
}

// MARK: The app's plain telemetry

/** One kind of the queue: what is waiting, how a batch goes out, and how it leaves the queue. */
export type TelemetryQueueView<T> = {
  /** Which kind of records this is. */
  readonly kind: "events" | "logs";
  /** The records waiting to be sent, oldest first. */
  readonly take: () => T[];
  /** The body a batch goes out in. */
  readonly body: (batch: T[]) => string;
  /** The records that were sent leave the queue. */
  readonly remove: (batch: T[]) => void;
};

/** A request that was sent, for the app's own diagnostics. */
export type RequestLogEntry = {
  readonly at: string;
  readonly kind: "events" | "logs";
  readonly url: string;
  readonly count: number;
  readonly bytes: number;
  readonly status: number | null;
  readonly dryRun?: boolean;
};

/**
 * The app's telemetry, as its plain side keeps it: the queue, the consent, and the identity behind it.
 *
 * The plain side owns this because the app's own code has to reach it at once. An opt-out is a click: it stops the
 * uploads, empties the queue and forgets the identity without waiting for a delivery that may be running.
 */
export type TelemetryConsole = {
  /** Whether the user shares diagnostics. Nothing goes out while this is false. */
  readonly sharing: () => boolean;
  /** The queue's generation. It moves when sharing is turned off, and a result from an older one is stale. */
  readonly generation: () => number;
  /** The events waiting to be sent. */
  readonly events: TelemetryQueueView<QueuedEvent>;
  /** The logs waiting to be sent. */
  readonly logs: TelemetryQueueView<OtlpLogRecord>;
  /** The uploads in flight: the app's opt-out stops them. */
  readonly inflight: Set<() => void>;
  /** Told about a request that went out, for the app's own diagnostics. */
  readonly recorded: (entry: RequestLogEntry, body: string) => void;
  /** The queue as it goes on disk. */
  readonly serialized: () => string;
  /** The queue the app left on disk, to be merged into the one it keeps. */
  readonly restore: (contents: string) => void;
  /** Told when the queue changes, so the schedule can wake up for it. */
  readonly subscribe: (listener: () => void) => () => void;
};

// MARK: The service

/** What one request to the collector came to. */
type PostResult =
  /** The collector answered. */
  | { readonly kind: "answered"; readonly status: number; readonly retryAfterMs?: number }
  /** The collector could not be reached. */
  | { readonly kind: "failed" }
  /** The request was stopped: the user turned sharing off, or the delivery was cancelled. */
  | { readonly kind: "stopped" };

/** How a delivery ended. */
type DrainResult =
  /** The queue is empty: everything went out. */
  | { readonly kind: "done" }
  /** The collector could not be reached: what is left stays in the queue. */
  | { readonly kind: "failed"; readonly retryAfterMs?: number }
  /** The user turned sharing off: the queue it came from is gone. */
  | { readonly kind: "stale" };

export class DiagnosticsService extends Context.Service<
  DiagnosticsService,
  {
    /** Starts the delivery: the console the app's plain code keeps, and the slot it runs on. */
    readonly start: (telemetry: TelemetryConsole) => Effect.Effect<void>;
    /** Sends the queue now, and waits for the batches that went out. A wait the collector asked for still holds. */
    readonly deliver: () => Effect.Effect<void>;
  }
>()("bay/DiagnosticsService") {
  static readonly layer = Layer.effect(
    DiagnosticsService,
    Effect.gen(function* () {
      const engine = yield* TelemetryEngine;
      const scheduler = yield* Scheduler;
      const diagnostics = yield* Diagnostics;

      // The app's clock. The delivery and the slot that schedules it read the same one, so they cannot disagree
      // about when a wait is over.
      const clock = yield* Clock.Clock;

      // The console the app's plain code keeps. It is the app's own state; this service works on it.
      let telemetry: TelemetryConsole | undefined;

      // Whether a delivery is running: the queue goes out one batch at a time.
      let delivering = false;

      // How many deliveries have failed in a row: the wait before the next one grows with it.
      let failures = 0;

      // The earliest the next delivery may run.
      let retryAt = 0;

      // The generation the last delivery ran in. It moves when the user turns sharing off.
      let lastGeneration = 0;

      // One batch to the collector: the request, the answer, and what it means for the queue.
      const post = (app: TelemetryConsole, kind: "events" | "logs", body: string, count: number): Effect.Effect<PostResult> =>
        Effect.gen(function* () {
          const controller = new AbortController();
          const stop = () => controller.abort();

          // The upload is in flight, so the app's opt-out has something to stop.
          app.inflight.add(stop);

          const answer = yield* Effect.gen(function* () {
            for (let attempt = 0; ; attempt++) {
              const exit = yield* Effect.exit(engine.upload({ url: LOGS_URL, body, signal: controller.signal }));

              // The collector answered: the batch is its own now.
              if (Exit.isSuccess(exit)) return exit.value;

              // The user turned sharing off: the request is not ours to send, and it is not tried again.
              if (controller.signal.aborted) return null;

              // The tries are spent: the batch is kept, and a later delivery tries it again.
              if (attempt >= UPLOAD_RETRIES) return null;

              // The wait grows with the attempt, and a little of it is random so two apps do not wake together.
              yield* clock.sleep(Duration.millis(retryDelay(attempt + 1)));
            }
          }).pipe(
            // The collector is not waited for forever: the tries fit inside the deadline.
            Effect.timeout(Duration.millis(UPLOAD_TIMEOUT_MS)),
            // A request that could not be made is not a failure of the app: the batch waits for the next delivery.
            Effect.catch(() => Effect.succeed(null)),
            Effect.ensuring(Effect.sync(() => app.inflight.delete(stop))),
          );

          // A dry run never reached the collector, so it has no status of its own.
          const status = answer ? (answer.dryRun ? null : answer.status) : 0;

          // The request is written down either way: what went out, and what did not.
          app.recorded(
            {
              at: new Date().toISOString(),
              kind,
              url: LOGS_URL,
              count,
              bytes: body.length,
              status,
              dryRun: answer?.dryRun,
            },
            body,
          );

          if (answer) return { kind: "answered", status: answer.status, retryAfterMs: answer.retryAfterMs } as const;

          // The user turned sharing off: the queue it came from is gone.
          if (controller.signal.aborted) return { kind: "stopped" } as const;

          // The collector could not be reached: the batch is kept and tried again later.
          return { kind: "failed" } as const;
        });

      // The queue goes out in batches, until it is empty or the collector says otherwise.
      const drain = <T>(app: TelemetryConsole, queue: TelemetryQueueView<T>, gen: number): Effect.Effect<DrainResult> =>
        Effect.gen(function* () {
          let size = BATCH_SIZE;

          for (let batch = queue.take().slice(0, size); batch.length; batch = queue.take().slice(0, size)) {
            const body = queue.body(batch);

            // A body the collector will not take is sent in smaller pieces.
            if (body.length > MAX_BODY_BYTES && batch.length > 1) {
              size = Math.ceil(batch.length / 2);

              continue;
            }

            const answer = yield* post(app, queue.kind, body, batch.length);

            // The user turned sharing off while the batch was in flight: it is not ours to send, and the queue it
            // came from is gone.
            if (answer.kind === "stopped" || gen !== app.generation()) return { kind: "stale" };

            // The collector could not be reached: the batch is kept, and a later delivery tries it again.
            if (answer.kind === "failed") return { kind: "failed" };

            const result = outcome(answer.status, batch.length);

            if (result === "retry") {
              // A rate limit says when it will take the batch again: the delivery waits for the collector's timing.
              return { kind: "failed", retryAfterMs: answer.retryAfterMs };
            }

            if (result === "split") {
              size = Math.ceil(batch.length / 2);
            } else {
              queue.remove(batch);
            }
          }

          return { kind: "done" };
        });

      const flush = (app: TelemetryConsole): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!app.sharing() || delivering) return;

          const gen = app.generation();

          // The user turned sharing off and on again: the wait of the last choice does not carry over.
          if (gen !== lastGeneration) {
            lastGeneration = gen;
            failures = 0;
            retryAt = 0;
          }

          // The collector said when it will take the batch again: the delivery waits for that, whoever asked for it.
          if (clock.currentTimeMillisUnsafe() < retryAt) return;

          delivering = true;

          const result = yield* Effect.ensuring(
            Effect.gen(function* () {
              const events = yield* drain(app, app.events, gen);

              return events.kind === "done" ? yield* drain(app, app.logs, gen) : events;
            }),
            // The queue goes out one delivery at a time, whoever asked for it.
            Effect.sync(() => {
              delivering = false;
            }),
          );

          // The delivery the user cut short leaves the queue alone: what is left is theirs, or it is gone.
          if (result.kind === "stale") {
            failures = 0;
            retryAt = 0;

            return;
          }

          yield* engine.writeQueue(app.serialized()).pipe(Effect.catch(() => Effect.void));

          if (result.kind === "failed") {
            failures++;

            // The collector's own timing wins when it gave one: a rate limit says when it will take the batch.
            const wait = result.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));

            retryAt = clock.currentTimeMillisUnsafe() + wait;

            // The collector could not be reached. It is worth knowing, once, where every other failure goes.
            yield* diagnostics.report({ operation: { name: "telemetry.delivery" }, message: "The telemetry could not be sent" });

            return;
          }

          failures = 0;
          retryAt = 0;
        });

      const start = (app: TelemetryConsole): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (telemetry === app) return Effect.void;

          telemetry = app;

          return Effect.gen(function* () {
            // The queue the app left on disk is merged into the one it keeps.
            const stored = yield* engine.readQueue().pipe(Effect.catch(() => Effect.succeed(null)));

            if (stored) app.restore(stored);

            // The delivery runs on the app's shared grid: its periods are multiples of the others, so the telemetry
            // wakes with the rest of the app's slow work instead of on a timer of its own.
            yield* scheduler.every({
              every: FLUSH_DELAY_MS,
              needed: () => app.events.take().length > 0 || app.logs.take().length > 0,
              watch: (changed) => app.subscribe(changed),
              // The delivery keeps the collector's own timing: while a wait is open, the slot does nothing and the
              // next one tries again.
              run: flush(app),
            });
          });
        });

      const deliver = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          const app = telemetry;

          if (!app) return Effect.void;

          return flush(app);
        });

      return DiagnosticsService.of({ start, deliver });
    }),
  );
}

// MARK: The plain parts

/** Whether this build may send at all: a development build only does when it is asked to. */
export const canSend = () => !__DEV__ || launchEnvironment(DEV_SEND_ENV) === "1";

// The wait before the next try: it grows with the attempt, and a little of it is random so two apps do not wake at
// the same moment.
const retryDelay = (attempt: number) => Math.round(RETRY_DELAY_MS * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));

// When the collector will take the batch again: a number of seconds, or a moment it named.
const retryAfter = (response: Response): number | undefined => {
  const header = response.headers.get("retry-after");

  if (!header) return undefined;

  const seconds = Number(header);

  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(header);

  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};

// A signal that is cancelled when either of the two is: the app's opt-out, and the fiber's interruption.
const link = (outer: AbortSignal | undefined, inner: AbortSignal): AbortSignal => {
  if (!outer) return inner;

  if (outer.aborted) return AbortSignal.abort();

  const controller = new AbortController();
  const cancel = () => controller.abort();

  outer.addEventListener("abort", cancel, { once: true });
  inner.addEventListener("abort", cancel, { once: true });

  return controller.signal;
};
