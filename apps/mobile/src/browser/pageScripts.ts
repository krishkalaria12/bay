// Page scripts, as the app runs them. A script goes to a page through the engine port and its answer comes back
// read, or as a failure that says why it didn't: the page didn't answer in time, it answered with something the app
// couldn't read, or its answer wasn't the shape the caller expected. A page script can't be stopped, so interrupting
// one only drops its answer; the engine's ten-second limit still ends the wait. Nothing here retries: the next
// navigation runs a script again where that matters.
import type { Tab } from "@bay/engine";
import * as Effect from "effect/Effect";
import * as v from "valibot";
import { runCommand } from "../effect/commands.ts";
import { DecodeError, type Operation } from "../effect/errors.ts";
import { Engine, type PageScriptFailed, type PageScriptTimeout } from "../effect/ports/engine.ts";

/** Why a page script gave the app no answer it can use. */
export type PageScriptError = PageScriptTimeout | PageScriptFailed | DecodeError;

const OPERATION: Operation = { name: "pageScript" };

/** Runs a script in a page and reads its answer as the caller's type. */
export const run = <A>(view: Tab, script: string): Effect.Effect<A, PageScriptError, Engine> =>
  Effect.gen(function* () {
    const engine = yield* Engine;

    return yield* engine.runPageScript<A>(view, script);
  });

/** Runs a script in a page and checks its answer against `schema`, since a page can answer with anything. */
export const read = <S extends v.GenericSchema>(view: Tab, script: string, schema: S): Effect.Effect<v.InferOutput<S>, PageScriptError, Engine> =>
  Effect.gen(function* () {
    const parsed = v.safeParse(schema, yield* run<v.InferInput<S>>(view, script));

    if (!parsed.success) return yield* Effect.fail(new DecodeError({ operation: OPERATION, cause: new v.ValiError(parsed.issues) }));

    return parsed.output;
  });

/**
 * Drops the failures a page script is expected to have: a page that is loading, gone or busy doesn't answer, and
 * the script runs again on the next navigation where that matters. A defect is not dropped.
 */
export const quietly = <A, R>(effect: Effect.Effect<A, PageScriptError, R>): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

/**
 * Runs a script in a page for a caller that doesn't wait for it, and hands its answer to `onAnswer` when there is one.
 * The expected failures are dropped; a defect, in the answer's handler too, is reported once.
 */
export function sendPageScript<A>(view: Tab, script: string, onAnswer?: (answer: A) => void): void {
  runCommand(
    OPERATION,
    quietly(
      Effect.flatMap(run<A>(view, script), (answer) =>
        Effect.sync(() => {
          onAnswer?.(answer);
        }),
      ),
    ),
  );
}

/** What a failed page script says to the user: the words the engine has always used for it. */
export function pageScriptFailure(error: PageScriptError): Error {
  if (error._tag === "PageScriptTimeout") return new Error("The page didn't answer.");

  return error.cause instanceof Error ? error.cause : new Error(String(error.cause));
}
