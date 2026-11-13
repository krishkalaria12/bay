// The app's diagnostics: a failure is reported once, and only where the user shares it. The consent gate stays where
// it is (telemetry/client.ts); this is the only way desktop orchestration reaches it, so a workflow can never report
// around it.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { captureException } from "../../telemetry/errors";
import { recordLog } from "../../telemetry/logs";
import type { Operation } from "../errors";

/** A failure worth telling the user about, or the diagnostics about. */
export type Diagnostic = {
  /** What was being done, and to which resource. */
  readonly operation: Operation;
  /** What went wrong, in plain words. */
  readonly message: string;
  /** The failure behind it, when there is one: it carries the stack. */
  readonly cause?: Error;
};

export class Diagnostics extends Context.Service<
  Diagnostics,
  {
    /** Reports a failure through the consent-aware path. */
    readonly report: (diagnostic: Diagnostic) => Effect.Effect<void>;
    /** Notes something that is worth knowing but is not a failure. */
    readonly warn: (message: string) => Effect.Effect<void>;
  }
>()("bay/Diagnostics") {
  static readonly layer = Layer.succeed(Diagnostics)({
    report: (diagnostic) =>
      Effect.sync(() => {
        const where = diagnostic.operation.resource ? `${diagnostic.operation.name} (${diagnostic.operation.resource})` : diagnostic.operation.name;

        // The local log always names the operation; the report carries the failure's own stack.
        recordLog("error", [`${where}: ${diagnostic.message}`, diagnostic.cause].filter(Boolean));
        captureException(diagnostic.cause ?? new Error(diagnostic.message), "console");
      }),
    warn: (message) => Effect.sync(() => recordLog("warn", [message])),
  });
}
