// The app's diagnostics: a failure is reported once, into the ring of crash reports the user can send from Settings,
// and to the console. Nothing is uploaded and nothing is measured, so this is the only place a background failure
// ends up. A cancelled program is not a failure and is never recorded.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordCrash } from "../../crashReports.ts";
import { Cancelled, type Operation } from "../errors.ts";

/** A failure worth telling the user about, or the diagnostics about. */
export type Diagnostic = {
  /** What was being done, and to which resource. */
  readonly operation: Operation;
  /** What went wrong, in plain words. */
  readonly message: string;
  /** The failure behind it, when there is one: it carries the stack. */
  readonly cause?: Error;
};

/**
 * What a failure says, looking at what caused it. A tagged failure has no message of its own, but the thing behind
 * it usually does.
 */
const whatFailed = (error: Error): string => {
  if (error.message) return error.message;

  const cause = error.cause;

  return cause instanceof Error ? whatFailed(cause) : "";
};

export class Diagnostics extends Context.Service<
  Diagnostics,
  {
    /** Reports a failure. It is recorded once, in the crash-report ring. */
    readonly report: (diagnostic: Diagnostic) => Effect.Effect<void>;
    /** Notes something that is worth knowing but is not a failure. */
    readonly warn: (message: string) => Effect.Effect<void>;
  }
>()("bay/Diagnostics") {
  static readonly layer = Layer.succeed(Diagnostics)({
    report: (diagnostic) =>
      Effect.sync(() => {
        // Work that was stopped on purpose is not a failure: it is how cancelled work ends.
        if (diagnostic.cause instanceof Cancelled) return;

        const where = diagnostic.operation.resource ? `${diagnostic.operation.name} (${diagnostic.operation.resource})` : diagnostic.operation.name;
        const error = diagnostic.cause ?? new Error(diagnostic.message);

        // The crash report is what the user reads, so it names the operation as well as the failure.
        const failure = new Error(`${where}: ${whatFailed(error) || diagnostic.message || "it failed"}`);

        // The failure's own stack says where it happened, so it is kept.
        failure.stack = error.stack;

        recordCrash(failure);
        console.error(`${where}: ${diagnostic.message}`, error);
      }),
    warn: (message) => Effect.sync(() => console.warn(message)),
  });
}
