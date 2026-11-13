// The edge where plain JavaScript hands work to the runtime and reads the answer back. A native callback or a UI
// handler runs its program here: a failure is reported once through the diagnostics, an interruption is the
// expected end of cancelled work and stays silent, and a caller that asked for a promise gets a rejection.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { Operation } from "./errors";
import { Diagnostics } from "./ports/diagnostics";
import { desktopRuntime, type AppServices } from "./runtime";

/** How a command ended. */
export type CommandResult<A> =
  | { readonly _tag: "Done"; readonly value: A }
  | { readonly _tag: "Failed"; readonly error: Error }
  | { readonly _tag: "Cancelled" };

const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));

/** Reads an Exit as a command result, reporting a failure that is not an interruption. */
export const readCommandExit = <A>(operation: Operation, exit: Exit.Exit<A, unknown>): Effect.Effect<CommandResult<A>, never, Diagnostics> =>
  Effect.gen(function* () {
    if (Exit.isSuccess(exit)) return { _tag: "Done", value: exit.value };

    const cause = exit.cause;

    if (Cause.hasInterruptsOnly(cause)) return { _tag: "Cancelled" };

    const error = asError(Cause.squash(cause));
    const diagnostics = yield* Diagnostics;

    yield* diagnostics.report({ operation, message: error.message, cause: error });

    return { _tag: "Failed", error };
  });

/** Runs a program for a caller that cannot wait for it. */
export const runCommand = <A, E>(operation: Operation, program: Effect.Effect<A, E, AppServices>): void => {
  const workflow = Effect.gen(function* () {
    const exit = yield* Effect.exit(program);

    return yield* readCommandExit(operation, exit);
  });

  void desktopRuntime.runPromiseExit(workflow).then((exit) => {
    // The runtime itself could not run the program: there is nowhere else to report it.
    if (Exit.isFailure(exit)) console.error(`Command ${operation.name} could not run`, Cause.pretty(exit.cause));
  });
};

/** Runs a program for a caller that expects a promise: a failure rejects, an interruption rejects as a cancellation. */
export const runCommandPromise = <A, E>(program: Effect.Effect<A, E, AppServices>): Promise<A> => desktopRuntime.runPromise(program);

/** Runs a program and reads how it ended, without throwing. */
export const runCommandResult = <A, E>(operation: Operation, program: Effect.Effect<A, E, AppServices>): Promise<CommandResult<A>> =>
  desktopRuntime.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(program);

      return yield* readCommandExit(operation, exit);
    }),
  );
