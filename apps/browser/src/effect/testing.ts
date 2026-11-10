// The fakes a service test runs against: a scheduler whose jobs the test fires by hand, documents in memory, a
// network that answers from a script, diagnostics that keep what they were told, and a count of what the service
// still holds so a test can prove it let go.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Diagnostics, type Diagnostic } from "./ports/diagnostics";
import { DocumentError, Documents } from "./ports/documents";
import { DecodeError, Http, HttpError, type HttpRequest, type HttpResponse } from "./ports/http";
import { Scheduler, type ScheduledWork } from "./ports/scheduler";

/** The clock a test controls: time only moves when the test says so. */
export const testClockLayer = TestClock.layer();

/** Runs a program with the test clock in place. */
export const withTestClock = <A, E>(program: Effect.Effect<A, E, TestClock.TestClock>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(testClockLayer)));

/** What the diagnostics were told. */
export type FakeDiagnostics = {
  readonly layer: Layer.Layer<Diagnostics>;
  readonly reports: readonly Diagnostic[];
  readonly warnings: readonly string[];
};

/** Diagnostics that keep what they were told instead of sending it anywhere. */
export const fakeDiagnostics = (): FakeDiagnostics => {
  const reports: Diagnostic[] = [];
  const warnings: string[] = [];

  return {
    layer: Layer.succeed(Diagnostics)({
      report: (diagnostic) => Effect.sync(() => void reports.push(diagnostic)),
      warn: (message) => Effect.sync(() => void warnings.push(message)),
    }),
    reports,
    warnings,
  };
};

/** The documents a fake keeps, and how its saves behave. */
export type FakeDocuments = {
  readonly layer: Layer.Layer<Documents>;
  readonly files: Map<string, string>;
  /** Makes every save of `name` fail with `cause`. */
  readonly failSave: (name: string, cause: Error) => void;
  /** The saves that have not landed yet. */
  readonly pending: () => number;
};

/** Documents in memory: a read comes back what was written, and a save can be made to fail. */
export const fakeDocuments = (): FakeDocuments => {
  const files = new Map<string, string>();
  const failures = new Map<string, Error>();
  const pending = new Set<Promise<void>>();

  const save = (name: string, contents: string) =>
    Effect.tryPromise({
      try: () => {
        const failure = failures.get(name);

        if (failure) return Promise.reject(failure);

        const landing = new Promise<void>((resolve) => {
          setTimeout(() => {
            files.set(name, contents);
            resolve();
          }, 0);
        });

        pending.add(landing);
        landing.then(() => pending.delete(landing));

        return landing;
      },
      catch: (cause) => new DocumentError({ operation: { name: "document.save", resource: name }, cause }),
    });

  return {
    layer: Layer.succeed(Documents)({
      read: (name) => Effect.succeed(files.get(name) ?? null),
      write: (name, contents) => Effect.sync(() => void files.set(name, contents)),
      save,
      settled: Effect.suspend(() =>
        Effect.promise(async () => {
          while (pending.size > 0) await Promise.allSettled(pending);
        }),
      ),
    }),
    files,
    failSave: (name, cause) => void failures.set(name, cause),
    pending: () => pending.size,
  };
};

/** The requests a fake network was asked for. */
export type FakeHttp = {
  readonly layer: Layer.Layer<Http>;
  readonly requests: readonly HttpRequest[];
  /** Answers a request to `url` with `response`. */
  readonly answer: (url: string, response: HttpResponse) => void;
  /** Fails a request to `url` with `error`. */
  readonly fail: (url: string, error: Error) => void;
};

/** A network that answers from a script instead of the internet. */
export const fakeHttp = (): FakeHttp => {
  const requests: HttpRequest[] = [];
  const answers = new Map<string, HttpResponse | Error>();
  const noHeaders = { get: () => null };

  const send = (request: HttpRequest) =>
    Effect.suspend(() => {
      requests.push(request);
      const answer = answers.get(request.url);

      if (answer === undefined) {
        return Effect.fail(new HttpError({ operation: { name: "http.send", resource: request.url }, status: 404, cause: new Error("no answer") }));
      }

      if (answer instanceof Error) {
        return Effect.fail(new HttpError({ operation: { name: "http.send", resource: request.url }, status: 0, cause: answer }));
      }

      return Effect.succeed({ ...answer, headers: answer.headers ?? noHeaders });
    });

  return {
    layer: Layer.succeed(Http)({
      send,
      sendJson: (request, decode) =>
        send(request).pipe(
          Effect.flatMap((response) =>
            Effect.try({
              try: () => decode(response.body),
              catch: (cause) => new DecodeError({ operation: { name: "http.decode", resource: request.url }, cause }),
            }),
          ),
        ),
    }),
    requests,
    answer: (url, response) => void answers.set(url, response),
    fail: (url, error) => void answers.set(url, error),
  };
};

/** The jobs a fake scheduler is holding. */
export type FakeScheduler = {
  readonly layer: Layer.Layer<Scheduler>;
  readonly jobs: readonly ScheduledWork[];
  /** Runs every registered job now, and waits for the work to finish. */
  readonly fire: () => Promise<void>;
  /** Gives every registered job back, as closing the scope would. */
  readonly clear: () => void;
};

/** A scheduler that keeps its jobs until the test fires them. */
export const fakeScheduler = (): FakeScheduler => {
  const jobs: ScheduledWork[] = [];

  return {
    layer: Layer.succeed(Scheduler)({
      every: (job) => Effect.sync(() => void jobs.push(job)),
    }),
    jobs,
    fire: async () => {
      for (const job of jobs.slice()) await Effect.runPromiseExit(job.run);
    },
    clear: () => {
      jobs.length = 0;
    },
  };
};

/**
 * A count of what is still held, so a test can prove a service let go of everything it took.
 */
export class ResourceLedger {
  private readonly held = new Set<string>();

  /** Records that a resource was taken. */
  take(name: string): void {
    this.held.add(name);
  }

  /** Records that a resource was given back. */
  give(name: string): void {
    this.held.delete(name);
  }

  /** The resources that are still held. */
  outstanding(): readonly string[] {
    return [...this.held];
  }
}
