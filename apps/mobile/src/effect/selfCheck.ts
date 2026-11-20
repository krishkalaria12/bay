// A development build's check that Effect behaves under Hermes the way it does under Node, where the services are
// tested. It runs once, after the runtime is built, and tries the four things every service leans on: a layer, a
// finalizer, a typed failure and an interrupted sleep. Anything that misbehaves lands under Report a problem, so a
// Hermes incompatibility shows on the device and not only in a test run.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { TaggedError } from "effect/Data";
import { Diagnostics } from "./ports/diagnostics.ts";

class Probe extends Context.Service<Probe, { readonly answer: number }>()("bay/SelfCheck/Probe") {}

class ProbeFailed extends TaggedError("ProbeFailed")<{ readonly answer: number }> {}

/** What the check found wrong, one line each. Empty when Effect behaves. */
export const selfCheckProblems: Effect.Effect<readonly string[]> = Effect.gen(function* () {
  const problems: string[] = [];

  const answer = yield* Effect.provide(
    Probe.use((probe) => Effect.succeed(probe.answer)),
    Layer.succeed(Probe)({ answer: 42 }),
  );

  if (answer !== 42) problems.push("a layer didn't provide its service");

  let finalized = 0;

  yield* Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => void (finalized += 1)),
      );
    }),
  );

  if (finalized !== 1) problems.push("a finalizer didn't run exactly once");

  const failure = yield* Effect.exit(Effect.fail(new ProbeFailed({ answer: 7 })));
  const typed = Exit.isFailure(failure) ? Cause.squash(failure.cause) : undefined;

  if (!(typed instanceof ProbeFailed) || typed.answer !== 7) problems.push("a typed failure lost its type");

  const sleeping = yield* Effect.forkChild(Effect.sleep("1 hour"));

  yield* Fiber.interrupt(sleeping);

  const slept = yield* Fiber.await(sleeping);

  if (!Exit.isFailure(slept) || !Cause.hasInterruptsOnly(slept.cause)) problems.push("an interrupted sleep didn't end as an interruption");

  return problems;
});

/** Runs the check and reports each problem it finds. */
export const selfCheck: Effect.Effect<void, never, Diagnostics> = Effect.gen(function* () {
  const diagnostics = yield* Diagnostics;
  const problems = yield* selfCheckProblems;

  for (const problem of problems) yield* diagnostics.report({ operation: { name: "effect.selfCheck" }, message: `Effect self-check: ${problem}` });
});
