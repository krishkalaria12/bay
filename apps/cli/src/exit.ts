// How a bay command ends, and what it says on the way. A command that does not succeed fails with the status the
// shell sees; what it printed is already on stdout or stderr. The entry point turns that into the process's exit.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { installOutputRedaction, drainOutput } from "./redact.ts";

/** The command ended with this status. Its message, if it had one, is already printed. */
export class CommandExit extends Data.TaggedError("CommandExit")<{
  readonly status: number;
}> {}

/** Ends the command with `status`. */
export const exitWith = (status: number): Effect.Effect<never, CommandExit> => Effect.fail(new CommandExit({ status }));

/** Writes a line to stdout. */
export const say = (text: string): Effect.Effect<void> => Effect.sync(() => void process.stdout.write(`${text}\n`));

/** Writes a line to stderr. */
export const complain = (text: string): Effect.Effect<void> => Effect.sync(() => void process.stderr.write(`${text}\n`));

/** Says why the command stopped, on stderr, and ends it with `status`. */
export const failWith = (status: number, text: string): Effect.Effect<never, CommandExit> => complain(text).pipe(Effect.andThen(exitWith(status)));

/** What a failure says, in words. */
export const messageOf = <E>(error: E): string => (error instanceof Error ? error.message : String(error));

/**
 * Passes what the command writes through the redactor for its scope: secrets it learns (a token in the endpoint)
 * never reach the terminal, and what is held back is flushed when the scope closes.
 */
export const redactedOutput: Effect.Effect<void, never, Scope.Scope> = Effect.acquireRelease(Effect.sync(installOutputRedaction), () =>
  Effect.sync(drainOutput),
);
